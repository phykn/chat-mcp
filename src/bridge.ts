import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { dataDir } from './config.js';
import { bridgePort, bridgeProtocol, commandSchema, commandTimeoutFor, failure, type Command, type Reply } from './bridge-protocol.js';
import type { AddressInfo } from 'node:net';

const token = (await readFile(join(dataDir, 'bridge-token'), 'utf8')).trim();
const valid = (s: unknown) => typeof s === 'string' && Buffer.byteLength(s) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(s), Buffer.from(token));
let extension: WebSocket | undefined;
let activeRevision: string | undefined;
const pending = new Map<string, (value: Reply) => void>();
let lastActive = Date.now();
async function extensionRevision() {
  try { return (await readFile(join(dataDir, 'extension-revision'), 'utf8')).trim(); }
  catch { return undefined; }
}
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.headers.origin || !valid(req.headers.authorization?.replace(/^Bearer /, ''))) {
    res.writeHead(403).end(JSON.stringify(failure('FORBIDDEN', 'Local authenticated client required.'))); return;
  }
  lastActive = Date.now();
  if (req.method === 'GET' && req.url === '/health') {
    res.end(JSON.stringify({ service: 'chat-mcp', protocol: bridgeProtocol, pid: process.pid,
      connected: extension?.readyState === WebSocket.OPEN, extension_revision: activeRevision })); return;
  }
  if (req.method !== 'POST' || req.url !== '/rpc') { res.writeHead(404).end('{}'); return; }
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 100_000) throw new Error('Request too large');
      chunks.push(chunk);
    }
    const command = commandSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.end(JSON.stringify(await dispatch(command)));
  } catch { res.writeHead(400).end(JSON.stringify(failure('BAD_REQUEST', 'Invalid bridge request.'))); }
});

function dispatch(command: Command): Promise<Reply> {
  const expiresAt = Math.min(Date.now() + commandTimeoutFor(command), command.deadline ?? Infinity);
  if (expiresAt <= Date.now())
    return Promise.resolve(failure('COMMAND_EXPIRED', 'Request deadline expired before browser dispatch.'));
  const ws = extension;
  if (!ws || ws.readyState !== WebSocket.OPEN)
    return Promise.resolve(failure('EXTENSION_DISCONNECTED', 'Connect a ChatGPT tab with the Chat MCP extension.'));

  const id = randomUUID();
  return new Promise(resolve => {
    const finish = (reply: Reply) => {
      clearTimeout(timer);
      pending.delete(id);
      resolve(reply);
    };
    const timer = setTimeout(() => finish(failure('BRIDGE_TIMEOUT', 'Browser command outcome is unknown.')), Math.max(0, expiresAt - Date.now()));
    pending.set(id, finish);
    ws.send(JSON.stringify({ ...command, id, expiresAt }), error => {
      if (error) finish(failure('EXTENSION_DISCONNECTED', 'Browser send failed; command outcome may be unknown.'));
    });
  });
}
const sockets = new WebSocketServer({ noServer: true, maxPayload: 2_000_000 });
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/extension' || !/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin || '')) { socket.destroy(); return; }
  sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws));
});
sockets.on('connection', ws => {
  let authenticated = false;
  const authTimer = setTimeout(() => ws.close(), 5_000);
  ws.on('message', async bytes => {
    try {
      const msg = JSON.parse(bytes.toString());
      if (!authenticated) {
        if (!valid(msg.token) || (extension && extension.readyState === WebSocket.OPEN)) { ws.close(); return; }
        authenticated = true; clearTimeout(authTimer); extension = ws;
        activeRevision = typeof msg.revision === 'string' ? msg.revision : undefined;
        ws.send(JSON.stringify({ ready: true, revision: await extensionRevision() })); return;
      }
      if (msg.ping) { ws.send(JSON.stringify({ pong: true, revision: pending.size ? undefined : await extensionRevision() })); return; }
      if (typeof msg.id === 'string') pending.get(msg.id)?.(msg);
    } catch { ws.close(); }
  });
  ws.on('close', () => {
    clearTimeout(authTimer);
    if (extension === ws) {
      extension = undefined;
      activeRevision = undefined;
      for (const resolve of pending.values()) resolve(failure('EXTENSION_DISCONNECTED', 'Browser connection closed; command outcome may be unknown.'));
    }
  });
  ws.on('error', () => ws.close());
});
const port = Number(process.env.CHAT_MCP_BRIDGE_PORT || bridgePort);
server.listen(port, '127.0.0.1', () => console.error(`Chat MCP bridge listening on 127.0.0.1:${(server.address() as AddressInfo).port}`));
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EADDRINUSE') console.error(error.message);
  process.exit(error.code === 'EADDRINUSE' ? 0 : 1);
});
setInterval(() => {
  if (!extension && !pending.size && Date.now() - lastActive > 300_000) process.exit(0);
}, 30_000).unref();

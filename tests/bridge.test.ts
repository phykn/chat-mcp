import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createServer } from 'node:net';
import { ensureBridge } from '../dist/core/bridge-process.js';

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as any).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}

test('concurrent automatic starts reuse one bridge and a stopped bridge restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-mcp-autostart-'));
  const token = 'a'.repeat(64), port = await freePort();
  await writeFile(join(dir, 'bridge-token'), token);
  const health = async () => (await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${token}` } })).json() as Promise<any>;
  let pid: number | undefined;
  try {
    await Promise.all([ensureBridge(dir, port), ensureBridge(dir, port), ensureBridge(dir, port)]);
    pid = (await health()).pid;
    await ensureBridge(dir, port); assert.equal((await health()).pid, pid);
    process.kill(pid!); pid = undefined;
    await new Promise(resolve => setTimeout(resolve, 200));
    await ensureBridge(dir, port); pid = (await health()).pid;
    assert.ok(pid);
    const other = await mkdtemp(join(tmpdir(), 'chat-mcp-other-'));
    await writeFile(join(other, 'bridge-token'), 'b'.repeat(64));
    await assert.rejects(ensureBridge(other, port), (e: any) => e.code === 'BRIDGE_CONFLICT');
    assert.equal((await health()).pid, pid);
  } finally { if (pid) process.kill(pid); }
});

test('automatic start reports missing setup without spawning a bridge', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-mcp-unconfigured-'));
  await assert.rejects(ensureBridge(dir, await freePort()), (e: any) => e.code === 'SETUP_REQUIRED');
});

test('cold-start readiness waits for the extension without dispatching or retrying a command', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-mcp-ready-')), port = await freePort();
  const token = 'c'.repeat(64);
  await writeFile(join(dir, 'bridge-token'), token);
  const { url } = await ensureBridge(dir, port);
  const status = async () => (await fetch(url + '/health', { headers: { Authorization: `Bearer ${token}` } })).json() as Promise<any>;
  const pid = (await status()).pid;
  let ws: WebSocket | undefined;
  try {
    const waiting = ensureBridge(dir, port, true);
    await new Promise(resolve => setTimeout(resolve, 100));
    ws = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: 'chrome-extension://' + 'c'.repeat(32) });
    await once(ws, 'open'); ws.send(JSON.stringify({ token }));
    const [ready] = await once(ws, 'message');
    assert.equal(JSON.parse(ready.toString()).ready, true);
    let commands = 0;
    ws.on('message', () => commands++);
    await waiting;
    assert.equal((await status()).connected, true);
    assert.equal(commands, 0);
  } finally { ws?.close(); process.kill(pid); }
});

test('bridge rejects web origins and invalid credentials, routes only authenticated extension', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-mcp-bridge-'));
  const token = 'test-token-'.repeat(7);
  await writeFile(join(dir, 'bridge-token'), token);
  await writeFile(join(dir, 'extension-revision'), 'first');
  const child = spawn(process.execPath, ['dist/bridge.js'], { env: { ...process.env, CHAT_MCP_DATA_DIR: dir, CHAT_MCP_BRIDGE_PORT: '0' }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let ws: WebSocket | undefined;
  try {
    const ready = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('bridge startup timeout')), 5_000);
      child.stderr!.on('data', chunk => { const m = chunk.toString().match(/127\.0\.0\.1:(\d+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
    });
    const base = `http://127.0.0.1:${ready}`;
    const call = (headers: any = {}, command = 'snapshot', extra = {}) => fetch(base + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ command, ...extra }) });
    const auth = { Authorization: `Bearer ${token}` };
    assert.equal((await call()).status, 403);
    assert.equal((await call({ Authorization: `Bearer ${token}`, Origin: 'https://evil.invalid' })).status, 403);
    assert.equal((await (await call({ Authorization: `Bearer ${token}` })).json() as any).error.code, 'EXTENSION_DISCONNECTED');
    const bad = new WebSocket(`ws://127.0.0.1:${ready}/extension`, { origin: 'chrome-extension://' + 'a'.repeat(32) });
    await once(bad, 'open'); bad.send(JSON.stringify({ token: 'wrong' })); await once(bad, 'close');
    ws = new WebSocket(`ws://127.0.0.1:${ready}/extension`, { origin: 'chrome-extension://' + 'b'.repeat(32) });
    await once(ws, 'open'); ws.send(JSON.stringify({ token, revision: 'first' }));
    const [handshake] = await once(ws, 'message');
    assert.equal(JSON.parse(handshake.toString()).revision, 'first');
    await writeFile(join(dir, 'extension-revision'), 'updated');
    ws.send(JSON.stringify({ ping: true }));
    const [heartbeat] = await once(ws, 'message');
    assert.equal(JSON.parse(heartbeat.toString()).revision, 'updated');
    let received = 0;
    ws.on('message', bytes => { const msg = JSON.parse(bytes.toString()); if (msg.id) { received++; ws!.send(JSON.stringify({ id: msg.id, value: { ordinary: true } })); } });
    for (const command of ['unsupported', 'send', 'cancel', 'new']) {
      assert.equal((await call(auth, command)).status, 400);
    }
    assert.equal(received, 0, 'invalid commands must not reach the browser');
    const reply = await (await call({ Authorization: `Bearer ${token}` })).json() as any;
    assert.deepEqual(reply.value, { ordinary: true }); assert.equal(typeof reply.id, 'string');
    const overridden = await (await call(auth, 'snapshot', { id: 'caller-supplied-id' })).json() as any;
    assert.deepEqual(overridden.value, { ordinary: true });
    assert.notEqual(overridden.id, 'caller-supplied-id', 'bridge owns request correlation IDs');

    ws.removeAllListeners('message');
    const commands: string[] = [];
    ws.on('message', bytes => {
      commands.push(JSON.parse(bytes.toString()).id);
      if (commands.length === 2) ws!.close();
    });
    const disconnected = await Promise.all([call(auth), call(auth)]);
    for (const response of disconnected) {
      assert.equal((await response.json() as any).error.code, 'EXTENSION_DISCONNECTED');
    }
    assert.equal(commands.length, 2, 'disconnect settles every pending request without retry');
  } finally { ws?.close(); child.kill(); await once(child, 'exit'); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
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

test('a silent extension is evicted so a replacement can connect without replaying a pending command', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-mcp-heartbeat-'));
  const token = 'e'.repeat(64);
  await writeFile(join(dir, 'bridge-token'), token);
  // Advance only the watchdog clock; command timers retain their real deadlines.
  const clock = join(dir, 'clock.mjs');
  await writeFile(clock, `const now = Date.now; let offset = 0;
Date.now = () => now() + offset;
const interval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...args) => interval(fn, ms === 20000 ? 20 : ms, ...args);
process.on('message', ms => { offset += ms; process.send('advanced'); });`);
  const child = spawn(process.execPath, ['--import', pathToFileURL(clock).href, 'dist/bridge.js'], {
    env: { ...process.env, CHAT_MCP_DATA_DIR: dir, CHAT_MCP_BRIDGE_PORT: '0' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
  });
  const clients: WebSocket[] = [];
  try {
    const port = await new Promise<string>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => reject(Error(`Bridge exited during startup: ${code}`)));
      child.stderr!.on('data', chunk => {
        const match = chunk.toString().match(/127\.0\.0\.1:(\d+)/); if (match) resolve(match[1]);
      });
    });
    const connect = async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: 'chrome-extension://' + 'e'.repeat(32) });
      clients.push(ws); await once(ws, 'open');
      ws.send(JSON.stringify({ token }));
      assert.equal(JSON.parse((await once(ws, 'message'))[0].toString()).ready, true);
      return ws;
    };
    const advance = async (ms: number) => { const ack = once(child, 'message'); child.send(ms); await ack; };
    const ws = await connect();
    await advance(40_000);
    ws.send(JSON.stringify({ ping: true }));
    assert.equal(JSON.parse((await once(ws, 'message'))[0].toString()).pong, true);
    await advance(40_000);
    ws.send(JSON.stringify({ ping: true }));
    assert.equal(JSON.parse((await once(ws, 'message'))[0].toString()).pong, true, 'live connections survive');
    const observed = once(ws, 'message');
    const response = fetch(`http://127.0.0.1:${port}/rpc`, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'snapshot' }) });
    assert.equal(JSON.parse((await observed)[0].toString()).command, 'snapshot');
    const closed = once(ws, 'close'); await advance(60_000); await closed;
    assert.equal((await (await response).json() as any).error.code, 'EXTENSION_DISCONNECTED');
    const replacement = await connect();
    let replayed = false; replacement.on('message', () => { replayed = true; });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(replayed, false);
  } finally {
    for (const ws of clients) ws.terminate();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill(); await exited;
    }
  }
});

test('a slow Send can finish after 15 seconds while a shorter request deadline still wins', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-mcp-slow-send-')), port = await freePort();
  const token = 'd'.repeat(64);
  await writeFile(join(dir, 'bridge-token'), token);
  const { url } = await ensureBridge(dir, port);
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const health = await (await fetch(url + '/health', { headers: auth })).json() as any;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: 'chrome-extension://' + 'd'.repeat(32) });
  let delayed: ReturnType<typeof setTimeout> | undefined;
  try {
    await once(ws, 'open'); ws.send(JSON.stringify({ token })); await once(ws, 'message');
    const binding = { url: 'https://chatgpt.com/', baseline: [], marker: '[slow-send]' };
    const send = (deadline: number) => fetch(url + '/rpc', { method: 'POST', headers: auth,
      body: JSON.stringify({ command: 'send', args: { text: 'large editor input', binding }, deadline }) });
    let commands = 0;
    ws.on('message', bytes => {
      const msg = JSON.parse(bytes.toString());
      commands++;
      delayed = setTimeout(() => ws.send(JSON.stringify({ id: msg.id, value: { clicked: true } })), 16_000);
    });
    const completed = await (await send(Date.now() + 120_000)).json() as any;
    assert.deepEqual(completed.value, { clicked: true }, 'a slow editor must retain its send window');
    assert.equal(commands, 1, 'a slow Send must not be resent');
    ws.removeAllListeners('message');
    const deadline = Date.now() + 2_000;
    ws.on('message', bytes => {
      assert.equal(JSON.parse(bytes.toString()).expiresAt, deadline);
      commands++;
    });
    const expired = await (await send(deadline)).json() as any;
    assert.equal(expired.error.code, 'BRIDGE_TIMEOUT');
    assert.equal(commands, 2);
    assert.ok(Date.now() < deadline + 5_000, 'the whole-request deadline must bound a slow Send');
  } finally { clearTimeout(delayed); ws.close(); process.kill(health.pid); }
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
    ws.on('message', bytes => {
      const msg = JSON.parse(bytes.toString());
      if (msg.id) {
        const remaining = msg.expiresAt - Date.now();
        // Windows clocks in separate processes can differ by a millisecond.
        assert.ok(remaining > 0 && remaining <= 15_050, `Invalid remaining command lifetime: ${remaining}ms`);
        received++; ws!.send(JSON.stringify({ id: msg.id, value: { ordinary: true } }));
      }
    });
    for (const command of ['unsupported', 'send', 'cancel', 'new']) {
      assert.equal((await call(auth, command)).status, 400);
    }
    assert.equal(received, 0, 'invalid commands must not reach the browser');
    const expired = await (await call(auth, 'snapshot', { deadline: Date.now() - 1 })).json() as any;
    assert.equal(expired.error.code, 'COMMAND_EXPIRED');
    assert.equal(received, 0, 'expired commands must not reach the browser');
    const reply = await (await call({ Authorization: `Bearer ${token}` })).json() as any;
    assert.deepEqual(reply.value, { ordinary: true }); assert.equal(typeof reply.id, 'string');
    const overridden = await (await call(auth, 'snapshot', { id: 'caller-supplied-id', expiresAt: 0 })).json() as any;
    assert.deepEqual(overridden.value, { ordinary: true });
    assert.notEqual(overridden.id, 'caller-supplied-id', 'bridge owns request correlation IDs');

    ws.removeAllListeners('message');
    let boundedCommands = 0;
    const limit = Date.now() + 2_000;
    ws.on('message', bytes => {
      const msg = JSON.parse(bytes.toString());
      assert.equal(msg.expiresAt, limit);
      boundedCommands++;
    });
    const bounded = await (await call(auth, 'snapshot', { deadline: limit })).json() as any;
    assert.equal(bounded.error.code, 'BRIDGE_TIMEOUT');
    assert.equal(boundedCommands, 1);
    assert.ok(Date.now() < limit + 5_000, 'the request deadline must shorten the 15-second command timeout');

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

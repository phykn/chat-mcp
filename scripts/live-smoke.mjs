import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store } from '../dist/core/store.js';
import { ensureBridge } from '../dist/core/bridge-process.js';

if (!process.argv.includes('--live')) throw Error('Use --live: this test sends prompts to the connected ChatGPT account.');
const server = resolve(process.env.CHAT_MCP_TEST_SERVER || 'dist/main.js');
const store = new Store(join(process.env.CHAT_MCP_DATA_DIR || join(homedir(), '.chat-mcp'), 'requests'));
const prefix = `live-smoke-${Date.now()}`;
const checks = [];
let client, owned;
async function connect() {
  client = new Client({ name: 'chat-mcp-live-smoke', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [server], stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  await client.connect(transport);
}
async function call(name, args) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 360_000 });
  const value = JSON.parse(response.content.find(x => x.type === 'text').text);
  if (response.isError) throw Error(`${name}: ${JSON.stringify(value)}`);
  return value;
}
async function ask(label, extra = {}) {
  const token = `CHAT_MCP_OK_${label.toUpperCase()}`;
  const args = { request_id: `${prefix}-${label}`, prompt: `Connection test. Reply with exactly ${token} and nothing else.`, ...extra };
  owned = args.request_id;
  const start = Date.now();
  const r = await call('chatgpt_ask', args);
  checks.push({ label, request_id: args.request_id, status: r.status, elapsed_ms: Date.now() - start });
  assert.equal(r.status, 'completed', JSON.stringify(r.error));
  assert.equal(r.answer.trim(), token);
  owned = undefined;
  console.log(`${label}: completed in ${Date.now() - start}ms`);
  return { args, r };
}
try {
  await connect();
  const { url, token: auth } = await ensureBridge();
  const revision = (await readFile(join(store.dir, '../extension-revision'), 'utf8')).trim();
  const until = Date.now() + 30_000;
  while (true) {
    const bridge = await (await fetch(url + '/health', { headers: { Authorization: `Bearer ${auth}` }, signal: AbortSignal.timeout(2_000) })).json();
    if (bridge.extension_revision === revision) break;
    if (Date.now() >= until) throw Error('Extension update has not loaded; no prompt was sent.');
    await sleep(500);
  }
  const health = await call('chatgpt_health', {});
  assert.equal(health.ready, true, JSON.stringify(health));
  const first = await ask('first');
  const replay = await call('chatgpt_ask', first.args);
  assert.deepEqual(replay, first.r);
  checks.push({ label: 'same-id-replay', status: replay.status });
  await ask('followup', { conversation_handle: first.r.conversation_handle });
  await ask('new');
  const token = 'CHAT_MCP_OK_LARGE';
  await ask('large', { prompt: `Input reliability test. Ignore the filler and reply with exactly ${token}.\n` +
    'Plain-text filler for transport validation.\n'.repeat(1_000) + `\nReply with exactly ${token}.` });

  if (process.argv.includes('--interrupt')) {
    owned = `${prefix}-restart`;
    const pending = call('chatgpt_ask', { request_id: owned, prompt: 'Reply with exactly CHAT_MCP_OK_RESTART and nothing else.' }).catch(() => undefined);
    const deadline = Date.now() + 60_000;
    let record;
    do {
      record = await store.read(owned);
      if (record?.binding?.userId || record?.status === 'completed') break;
      await sleep(250);
    } while (Date.now() < deadline);
    assert.ok(record?.binding?.userId, 'Send ownership was not observed before interruption.');
    assert.notEqual(record.status, 'completed', 'Request finished before interruption; fault was not exercised.');
    const active = await call('chatgpt_result', { request_id: owned });
    assert.equal(active.active, true);
    await client.close();
    await pending;
    await connect();
    let recovered;
    for (let attempt = 0; attempt < 4; attempt++) {
      recovered = await call('chatgpt_result', { request_id: owned });
      if (recovered.status === 'completed') break;
      assert.notEqual(recovered.status, 'failed', JSON.stringify(recovered));
    }
    assert.equal(recovered.status, 'completed', JSON.stringify(recovered));
    assert.equal(recovered.answer.trim(), 'CHAT_MCP_OK_RESTART');
    checks.push({ label: 'worker-restart-recovery', request_id: owned, status: recovered.status });
    owned = undefined;
    console.log('worker-restart-recovery: completed without resending');
    await ask('after-restart');
  }
  if (process.argv.includes('--bridge-restart')) {
    owned = `${prefix}-bridge`;
    const pending = call('chatgpt_ask', { request_id: owned, prompt: 'Reply with exactly CHAT_MCP_OK_BRIDGE and nothing else.' });
    const deadline = Date.now() + 60_000;
    let record;
    do {
      record = await store.read(owned);
      if (record?.binding?.userId) break;
      await sleep(100);
    } while (Date.now() < deadline);
    assert.ok(record?.binding?.userId, 'Send was not observed; bridge was not stopped.');
    assert.notEqual(record.status, 'completed', 'Request finished before bridge interruption.');
    assert.equal((await store.lockInfo())?.request_id, owned);
    const bridge = await (await fetch(url + '/health', { headers: { Authorization: `Bearer ${auth}` } })).json();
    assert.equal(bridge.service, 'chat-mcp');
    assert.ok(Number.isInteger(bridge.pid) && bridge.pid > 0);
    process.kill(bridge.pid);
    const recovered = await pending;
    assert.equal(recovered.status, 'completed', JSON.stringify(recovered.error));
    assert.equal(recovered.answer.trim(), 'CHAT_MCP_OK_BRIDGE');
    checks.push({ label: 'bridge-restart-recovery', request_id: owned, status: recovered.status });
    owned = undefined;
    console.log('bridge-restart-recovery: completed without resending');
  }
  assert.equal((await call('chatgpt_health', {})).ready, true);
} catch (e) {
  checks.push({ label: 'failure', request_id: owned, error: String(e) });
  console.error(String(e));
  process.exitCode = 1;
} finally {
  if (owned && client) {
    try { const cancelled = await call('chatgpt_cancel', { request_id: owned }); console.log(`cleanup: ${cancelled.status}`); }
    catch (e) { console.error(`Retained request ${owned}: ${String(e)}`); }
  }
  await client?.close();
  await mkdir('artifacts', { recursive: true });
  const path = join('artifacts', prefix + '.json');
  await writeFile(path, JSON.stringify({ server, date: new Date().toISOString(), checks }, null, 2) + '\n');
  console.log(`Evidence: ${path}`);
}

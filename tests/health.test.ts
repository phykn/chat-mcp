import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { health } from '../src/health.js';
import { result } from '../src/result.js';
import { Store } from '../src/core/store.js';
import { Fault, type Adapter, type Record, type Snapshot } from '../src/core/types.js';

test('health distinguishes ready, drafts, wrong mode, and an unavailable extension', async () => {
  const store = new Store(await mkdtemp(join(tmpdir(), 'chat-mcp-health-')));
  const snapshot: Snapshot = { url: 'https://chatgpt.com/', ordinary: true, draft: '', generating: false, messages: [] };
  const adapter = { snapshot: async () => snapshot } as Adapter;
  assert.equal((await health(store, adapter)).ready, true);
  snapshot.draft = 'private draft';
  const draft = await health(store, adapter);
  assert.equal(draft.ready, false);
  assert.ok(draft.next_action);
  assert.ok(!JSON.stringify(draft).includes('private draft'));
  snapshot.draft = ''; snapshot.ordinary = false;
  assert.equal((await health(store, adapter)).ready, false);
  adapter.snapshot = async () => { throw new Fault('EXTENSION_DISCONNECTED', 'missing'); };
  const unavailable = await health(store, adapter);
  assert.equal(unavailable.ready, false);
  assert.ok(unavailable.next_action);
  assert.ok('extension_folder' in unavailable);
});

test('health keeps unresolved requests visible without dumping the entire history', async () => {
  const store = new Store(await mkdtemp(join(tmpdir(), 'chat-mcp-history-')));
  const record: Record = { id: 'pending', hash: 'h', handle: 'handle', status: 'unknown_commit', started: 1, updated: 1 };
  await store.write(record);
  for (let i = 0; i < 12; i++) await store.write({ ...record, id: String(i), status: 'completed', answer: 'private answer' });
  const adapter = { snapshot: async () => ({ ordinary: true, draft: '', generating: false }) } as Adapter;
  const state = await health(store, adapter);
  assert.equal(state.ready, false);
  assert.equal(state.requests.length, 6);
  assert.equal(state.requests[0].request_id, 'pending');
  assert.ok(!JSON.stringify(state).includes('private answer'));
});

test('valid reviews are returned once, while malformed reviews retain the original answer', () => {
  const answer = JSON.stringify({ findings: [], summary: 'No supported defects.' });
  const record: Record = { id: 'review', hash: 'h', handle: 'handle', status: 'completed', started: 1, updated: 1,
    material: { scope: 'working_tree', files: ['file.ts'], omitted: [] }, answer };
  const formatted = JSON.parse(result(record).content[0].text);
  assert.deepEqual(formatted.review, JSON.parse(answer));
  assert.equal(formatted.answer, undefined);
  assert.equal(record.answer, answer);
  const malformed = JSON.parse(result({ ...record, answer: 'Not JSON' }).content[0].text);
  assert.equal(malformed.answer, 'Not JSON');
  assert.ok(malformed.warning);
  const ask = JSON.parse(result({ ...record, material: { ...record.material!, scope: 'ask' } }).content[0].text);
  assert.equal(ask.answer, answer);
});

test('health is not ready while context collection holds a lock before creating a record', async () => {
  const store = new Store(await mkdtemp(join(tmpdir(), 'chat-mcp-preparing-')));
  const release = await store.lock('collecting');
  try {
    const adapter = { snapshot: async () => ({ ordinary: true, draft: '', generating: false }) } as Adapter;
    const state = await health(store, adapter);
    assert.equal(state.ready, false);
    assert.equal(state.operation?.request_id, 'collecting');
    assert.equal(state.operation?.active, true);
  } finally { await release(); }
});

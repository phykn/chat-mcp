import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, hash } from '../src/core/store.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { Fault, type Adapter, type Binding, type Snapshot, type Material, type Record } from '../src/core/types.js';

const material = async (): Promise<Material> => ({ prompt: '한국어\n```ts\nconst x = 1;\n```', scope: 'ask', files: [], omitted: [] });
class Fake implements Adapter {
  sends = 0; stops = 0; fail = false;
  state: Snapshot = { url: 'https://chatgpt.com/', ordinary: true, draft: '', generating: false, messages: [] };
  async snapshot() { return structuredClone(this.state); }
  async prepare(url?: string) {
    if (url && this.state.url !== url) throw new Fault('CONVERSATION_CHANGED', 'switched');
    return this.snapshot();
  }
  async send(text: string) {
    this.sends++;
    this.state.url = 'https://chatgpt.com/c/test';
    this.state.messages.push({ id: 'u' + this.sends, role: 'user', text, complete: false });
    if (this.fail) throw new Error('connection lost after click');
    this.reply();
  }
  reply(complete = true) {
    this.state.messages.push({ id: 'a' + this.sends, role: 'assistant', text: '답변', complete });
  }
  async cancel(_b: Binding) { this.stops++; this.state.generating = false; }
}
async function setup() {
  const store = new Store(await mkdtemp(join(tmpdir(), 'chat-mcp-core-')));
  const adapter = new Fake();
  const runner = new Orchestrator(store, adapter, 500, 5, 10);
  return { store, adapter, runner };
}
test('completed request replay avoids recollection and duplicate sends', async () => {
  const { runner, adapter } = await setup();
  const input = { request_id: 'same', prompt: 'hello' };
  assert.equal((await runner.run(input, material)).status, 'completed');
  assert.equal((await runner.run(input, async () => { throw Error('must not collect'); })).status, 'completed');
  assert.equal(adapter.sends, 1);
});
test('simultaneous same ID and separate process store reject BUSY', async () => {
  const { runner, store, adapter } = await setup();
  let entered!: () => void, release!: () => void;
  const signal = new Promise<void>(r => entered = r), gate = new Promise<void>(r => release = r);
  const first = runner.run({ request_id: 'same' }, async () => { entered(); await gate; return material(); });
  await signal;
  const other = new Orchestrator(new Store(store.dir), adapter);
  await assert.rejects(other.run({ request_id: 'same' }, material), (e: any) => e.code === 'BUSY');
  release(); await first; assert.equal(adapter.sends, 1);
});
test('same ID different contents is rejected without modifying saved state', async () => {
  const { runner, store } = await setup();
  await runner.run({ request_id: 'x', conversation_handle: undefined }, material);
  const before = await readFile(store.path('x'), 'utf8');
  await assert.rejects(runner.run({ request_id: 'x', conversation_handle: 'different' }, material), (e: any) => e.code === 'REQUEST_ID_CONFLICT');
  assert.equal(await readFile(store.path('x'), 'utf8'), before);
});
test('disconnect after send recovers matching answer without resend', async () => {
  const { runner, adapter } = await setup(); adapter.fail = true;
  assert.equal((await runner.run({ request_id: 'x' }, material)).status, 'unknown_commit');
  adapter.reply();
  assert.equal((await runner.run({ request_id: 'x' }, material)).status, 'completed');
  assert.equal(adapter.sends, 1);
});
test('timeout resumes; incomplete answer is not returned as completed', async () => {
  const { runner, adapter } = await setup();
  adapter.reply = function () { this.state.messages.push({ id: 'a', role: 'assistant', text: 'partial', complete: false }); };
  assert.equal((await runner.run({ request_id: 'x' }, material)).status, 'timed_out_after_send');
  adapter.state.messages.at(-1)!.complete = true;
  assert.equal((await runner.run({ request_id: 'x' }, material)).status, 'completed');
  assert.equal(adapter.sends, 1);
});

test('a hidden-page timeout explains recovery and resumes without another send', async () => {
  const { runner, adapter } = await setup();
  adapter.state.visible = false;
  adapter.reply = function () { this.state.messages.push({ id: 'a', role: 'assistant', text: 'partial', complete: false }); };
  const input = { request_id: 'hidden', prompt: 'hello' };
  const pending = await runner.run(input, material);
  assert.equal(pending.status, 'timed_out_after_send');
  assert.equal(pending.error?.code, 'PAGE_HIDDEN');
  assert.match(pending.error!.message, /Wake\/unlock/);
  adapter.state.visible = true;
  adapter.state.messages.at(-1)!.complete = true;
  const completed = await runner.run(input, async () => { throw Error('must not recollect or resend'); });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.error, undefined);
  assert.equal(adapter.sends, 1);
});
test('restart in sending state never resends even when marker is absent', async () => {
  const { runner, adapter, store } = await setup();
  await store.init();
  const r: Record = { id: 'x', hash: hash({ request_id: 'x' }), status: 'sending', started: Date.now(), updated: Date.now(), handle: 'h', binding: { url: adapter.state.url, baseline: [], marker: '[missing]' } };
  await store.write(r);
  assert.equal((await runner.run({ request_id: 'x' }, material)).status, 'unknown_commit');
  assert.equal(adapter.sends, 0);
});

test('cancel after a crash in prepared state is terminal and never touches the browser', async () => {
  const { runner, adapter, store } = await setup();
  await store.init();
  await store.write({ id: 'prepared', hash: hash({ request_id: 'prepared' }), status: 'prepared',
    started: Date.now(), updated: Date.now(), handle: 'h',
    binding: { url: adapter.state.url, baseline: [], marker: '[prepared]' } });
  adapter.snapshot = async () => { throw Error('browser is offline'); };
  assert.equal((await runner.cancel('prepared')).status, 'cancelled');
  assert.equal((await runner.run({ request_id: 'prepared' }, async () => { throw Error('must not collect'); })).status, 'cancelled');
  assert.equal(adapter.sends, 0);
  assert.equal(adapter.stops, 0);
});
test('failed durable write prevents any send', async () => {
  const { runner, store, adapter } = await setup();
  store.write = async () => { throw Error('disk full'); };
  await assert.rejects(runner.run({ request_id: 'x' }, material));
  assert.equal(adapter.sends, 0);
});
test('wrong mode and previous answer cannot become success', async () => {
  const { runner, adapter } = await setup(); adapter.state.ordinary = false;
  await assert.rejects(runner.run({ request_id: 'x' }, material), (e: any) => e.code === 'NOT_ORDINARY_CHAT');
  assert.equal(adapter.sends, 0);
});
test('user conversation switch after send is reported, with no resend', async () => {
  const { runner, adapter } = await setup();
  adapter.send = async () => { adapter.sends++; adapter.state.url = 'https://chatgpt.com/c/other'; };
  const r = await runner.run({ request_id: 'x' }, material);
  assert.equal(r.status, 'unknown_commit'); assert.equal(r.error?.code, 'CONVERSATION_CHANGED');
  assert.equal(adapter.sends, 1);
});
test('another request cannot displace an unresolved generation', async () => {
  const { runner, adapter } = await setup(); adapter.fail = true;
  await runner.run({ request_id: 'x' }, material);
  await assert.rejects(runner.run({ request_id: 'y' }, material), (e: any) => e.code === 'BUSY');
  assert.equal(adapter.sends, 1);
});
test('cancel passes durable signal without waiting for operation lock', async () => {
  const { runner, adapter, store } = await setup(); runner.timeout = 10_000;
  adapter.reply = function () { this.state.generating = true; };
  let notify!: () => void;
  const sent = new Promise<void>(resolve => notify = resolve);
  const write = store.write.bind(store);
  store.write = async record => { await write(record); if (record.status === 'sent') notify(); };
  const task = runner.run({ request_id: 'x' }, material);
  await Promise.race([sent, task.then(() => assert.fail('request finished before cancellation'))]);
  const signal = await runner.cancel('x');
  assert.ok(['cancel_requested', 'cancelled'].includes(signal.status));
  assert.equal((await task).status, 'cancelled'); assert.equal(adapter.stops, 1);
});
test('follow-up uses saved handle and current conversation', async () => {
  const { runner, adapter } = await setup();
  const first = await runner.run({ request_id: 'x' }, material);
  const next = await runner.run({ request_id: 'y', conversation_handle: first.handle }, material);
  assert.equal(next.status, 'completed'); assert.equal(next.handle, first.handle); assert.equal(adapter.sends, 2);
});
test('completion requires stopped generation AND completion control', async () => {
  const { runner, adapter } = await setup(); adapter.state.generating = true;
  assert.equal((await runner.run({ request_id: 'x' }, material)).status, 'timed_out_after_send');
});

test('an input failure before clicking can be cancelled through the adapter ownership check', async () => {
  const { runner, adapter } = await setup();
  adapter.send = async text => { adapter.sends++; adapter.state.draft = text; throw Error('connection lost before click'); };
  adapter.cancel = async binding => {
    assert.equal(binding.draftHash, hash(adapter.state.draft));
    assert.equal(binding.userId, undefined);
    adapter.state.draft = ''; adapter.stops++;
  };
  assert.equal((await runner.run({ request_id: 'draft' }, material)).status, 'unknown_commit');
  assert.equal((await runner.cancel('draft')).status, 'cancelled');
  assert.equal(adapter.state.draft, '');
  assert.equal(adapter.sends, 1);
  assert.equal(adapter.stops, 1);
});

test('cancellation after recovery records elapsed time and clears the previous error', async () => {
  const { runner, adapter, store } = await setup();
  adapter.fail = true;
  assert.equal((await runner.run({ request_id: 'elapsed' }, material)).status, 'unknown_commit');
  const cancelled = await runner.cancel('elapsed');
  assert.equal(cancelled.status, 'cancelled');
  const saved = (await store.read('elapsed'))!;
  assert.equal(typeof saved.elapsed_ms, 'number');
  assert.equal(saved.error, undefined);
});

test('a definitive pre-send rejection does not leave the tab blocked by an uncertain request', async () => {
  const { runner, adapter } = await setup();
  const send = adapter.send.bind(adapter);
  adapter.send = async () => { throw new Fault('INPUT_MISMATCH', 'No send was clicked'); };
  assert.equal((await runner.run({ request_id: 'rejected' }, material)).status, 'failed');
  adapter.send = send;
  assert.equal((await runner.run({ request_id: 'next' }, material)).status, 'completed');
  assert.equal(adapter.sends, 1);
});

for (const code of ['INPUT_MISMATCH', 'INPUT_FAILED', 'SEND_UNAVAILABLE', 'CONVERSATION_CHANGED'])
test(`a ${code} failure can clear its unchanged draft, preserving user edits`, async () => {
  const { runner, adapter } = await setup();
  adapter.send = async text => { adapter.state.draft = text; throw new Fault(code, 'Send was not clicked'); };
  adapter.cancel = async binding => {
    if (hash(adapter.state.draft) !== binding.draftHash) throw new Fault('NOT_OWNER', 'User edited draft');
    adapter.state.draft = ''; adapter.stops++;
  };
  assert.equal((await runner.run({ request_id: 'failed-draft' }, material)).status, 'failed');
  const original = adapter.state.draft;
  adapter.state.draft += 'user edit';
  await assert.rejects(runner.cancel('failed-draft'), (e: any) => e.code === 'NOT_OWNER');
  assert.equal(adapter.state.draft, original + 'user edit');
  adapter.state.draft = original;
  assert.equal((await runner.cancel('failed-draft')).status, 'cancelled');
  assert.equal(adapter.state.draft, '');
  assert.equal(adapter.stops, 1);
});

test('navigation after send can temporarily hide the composer while keeping message nodes', async () => {
  const { runner, adapter } = await setup();
  const snapshot = adapter.snapshot.bind(adapter);
  let loading = 3;
  adapter.snapshot = async () => {
    const state = await snapshot();
    if (adapter.sends && loading-- > 0) state.ordinary = false;
    return state;
  };
  assert.equal((await runner.run({ request_id: 'spa-navigation' }, material)).status, 'completed');
  assert.equal(adapter.sends, 1);
});

test('navigation can mount an empty user message before rendering its request marker', async () => {
  const { runner, adapter } = await setup();
  const snapshot = adapter.snapshot.bind(adapter);
  let loading = 3;
  adapter.snapshot = async () => {
    const state = await snapshot();
    if (adapter.sends && loading-- > 0) state.messages[0].text = '';
    return state;
  };
  assert.equal((await runner.run({ request_id: 'loading-marker' }, material)).status, 'completed');
  assert.equal(adapter.sends, 1);
});

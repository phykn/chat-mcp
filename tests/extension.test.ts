import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExtensionAdapter } from '../src/adapters/extension.js';
import { Fault, type Snapshot } from '../src/core/types.js';

const home: Snapshot = { url: 'https://chatgpt.com/', ordinary: true, draft: '', generating: false, messages: [] };

test('preparation tolerates a temporary missing content script and incomplete first render', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const adapter = new ExtensionAdapter();
  let reads = 0;
  adapter.snapshot = async () => {
    t.mock.timers.tick(8_000);
    if (++reads === 1) throw new Fault('CONTENT_UNAVAILABLE', 'Navigation');
    return { ...home, ordinary: reads > 2 };
  };
  assert.equal((await adapter.prepare()).ordinary, true);
  assert.equal(reads, 3);
});

test('a slow new-chat render gets its full readiness window', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const adapter = new ExtensionAdapter();
  let navigations = 0, reads = 0;
  (adapter as any).rpc = async () => { navigations++; };
  adapter.snapshot = async () => {
    if (!navigations) return { ...home, url: home.url + 'c/old' };
    t.mock.timers.tick(4_000);
    return { ...home, ordinary: ++reads >= 5 };
  };
  assert.equal((await adapter.prepare()).ordinary, true);
  assert.equal(navigations, 1);
  assert.equal(reads, 5);
});

test('a lost new-chat acknowledgement is recovered by observing without repeating navigation', async () => {
  const adapter = new ExtensionAdapter();
  let navigations = 0;
  (adapter as any).rpc = async () => { navigations++; throw new Fault('BRIDGE_TIMEOUT', 'Lost acknowledgement'); };
  adapter.snapshot = async () => ({ ...home, url: navigations ? home.url : home.url + 'c/old' });
  assert.equal((await adapter.prepare()).url, home.url);
  assert.equal(navigations, 1);
});

test('readiness remains bounded and never navigates an occupied or different managed chat', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const adapter = new ExtensionAdapter();
  (adapter as any).rpc = async () => assert.fail('must not navigate');
  adapter.snapshot = async () => { t.mock.timers.tick(15_000); return { ...home, ordinary: false }; };
  await assert.rejects(adapter.prepare(), (e: any) => e.code === 'NOT_ORDINARY_CHAT');
  adapter.snapshot = async () => ({ ...home, draft: 'user draft' });
  await assert.rejects(adapter.prepare(), (e: any) => e.code === 'DRAFT_PRESENT');
  adapter.snapshot = async () => ({ ...home, url: home.url + 'c/other' });
  await assert.rejects(adapter.prepare(home.url + 'c/owned'), (e: any) => e.code === 'CONVERSATION_CHANGED');
  adapter.snapshot = async () => { throw new Fault('BRIDGE_CONFLICT', 'Another service'); };
  await assert.rejects(adapter.prepare(), (e: any) => e.code === 'BRIDGE_CONFLICT');
});

test('an expired request cannot dispatch Send even when no bridge is running', async () => {
  const adapter = new ExtensionAdapter();
  await assert.rejects(adapter.send('must not send', { url: home.url, baseline: [], marker: '[expired]' }, Date.now() - 1),
    (e: any) => e.code === 'COMMAND_EXPIRED');
});

test('reasoning configuration forwards the requested effort and binding to the bridge', async () => {
  const adapter = new ExtensionAdapter();
  const binding = { url: home.url, baseline: [], marker: '[reasoning]' };
  const calls: unknown[] = [];
  (adapter as any).rpc = async (command: unknown) => {
    calls.push(command);
    return { ...home, reasoning: { effort: 'high', raw: 'high', label: 'High' } };
  };
  const configured = await adapter.configure(binding, 'high');
  assert.deepEqual(calls[0], { command: 'configure', args: { binding, reasoning_effort: 'high' } });
  assert.equal(configured.reasoning?.raw, 'high');
  await adapter.configure(binding);
  assert.deepEqual(calls[1], { command: 'configure', args: { binding, reasoning_effort: undefined } });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

async function fixture(local: any = {}, session: any = {}, tabs = [{ id: 1, url: 'https://chatgpt.com/c/old' }]) {
  const sent: number[] = [], injected: number[] = [], updated: any[] = [], sockets: Socket[] = [];
  const listeners: any = {}, pages = new Map(tabs.map(tab => [tab.id, { windowId: 7, ...tab }])), reloads = { count: 0 };
  const windows: any[] = [], pageReloads: number[] = [], updates: any[] = [];
  let windowState = 'minimized', onReload: (() => void) | undefined, onFocus: (() => void) | undefined;
  let contentReply: ((msg: any) => any) | undefined;
  const loaded = new Set<number>();
  const clock = { now: Date.now() };
  const intervals = new Map<number, () => void>();
  let intervalId = 0;
  let pageSnapshot: any;
  let waitForTab: (() => Promise<void>) | undefined;
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 0;
    replies: any[] = [];
    onopen?: () => void; onclose?: () => void; onmessage?: (e: { data: string }) => Promise<void>;
    constructor() { sockets.push(this); }
    send(value: string) { this.replies.push(JSON.parse(value)); }
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
    message(command: string) { return this.onmessage!({ data: JSON.stringify({ id: 'request', command, args: { expectedUrl: 'https://chatgpt.com/c/old' } }) }); }
    signal(payload: any) { return this.onmessage!({ data: JSON.stringify(payload) }); }
  }
  const event = (name: string) => ({ addListener: (fn: any) => { listeners[name] = fn; } });
  const storage = (state: any) => ({ get: async (key: string) => ({ [key]: state[key] }),
    set: async (value: any) => { Object.assign(state, value); }, remove: async (key: string) => { delete state[key]; } });
  const chrome = {
    runtime: { onMessage: event('message'), onInstalled: event('installed'), reload: () => { reloads.count++; } },
    storage: { session: storage(session), local: storage(local) },
    scripting: { executeScript: async ({ target }: any) => { injected.push(target.tabId); loaded.add(target.tabId); } },
    alarms: { create: async () => {}, clear: async () => {}, onAlarm: event('alarm') },
    windows: { get: async () => ({ state: windowState }), update: async (id: number, change: any) => {
      windows.push({ id, ...change }); updates.push({ kind: 'window', id, ...change });
      windowState = change.state || windowState; onFocus?.();
    } },
    tabs: {
      get: async (id: number) => { if (waitForTab) await waitForTab(); const tab = pages.get(id); if (!tab) throw Error('No tab'); return tab; },
      query: async () => [...pages.values()],
      create: async ({ url }: any) => { const tab = { id: 10 + pages.size, windowId: 7, url }; pages.set(tab.id, tab); return tab; },
      sendMessage: async (id: number, msg: any) => { if (!loaded.has(id)) throw Error('No receiver'); sent.push(id); return contentReply?.(msg) || { value: pageSnapshot || { url: pages.get(id)!.url, draft: '', generating: false } }; },
      reload: async (id: number) => { pageReloads.push(id); onReload?.(); },
      update: async (id: number, change: any) => { updated.push({ id, ...change }); updates.push({ kind: 'tab', id, ...change }); return pages.get(id); },
      onRemoved: event('removed'), onUpdated: event('updated'), onReplaced: event('replaced'),
    },
  };
  const source = (await readFile('extension/background.js', 'utf8')).replace("import { token, revision } from './config.js';", "const token = 'fixture', revision = 'fixture';");
  runInNewContext(source, { chrome, WebSocket: Socket, Date: class extends Date { static now() { return clock.now; } },
    setInterval: (fn: () => void) => { intervals.set(++intervalId, fn); return intervalId; },
    clearInterval: (id: number) => intervals.delete(id),
    setTimeout: (fn: () => void, ms: number) => { if (ms === 200) { clock.now += ms; queueMicrotask(fn); } return 1; }, clearTimeout() {} });
  const call = (command: string, tabId?: number) => new Promise<any>(resolve => listeners.message({ command, tabId }, {}, resolve));
  await call('status');
  return { call, listeners, pages, sent, injected, updated, updates, sockets, local, reloads, clock, windows, pageReloads,
    tick: () => { for (const fn of [...intervals.values()]) fn(); },
    setReply: (fn: (msg: any) => any) => { contentReply = fn; }, onReload: (fn: () => void) => { onReload = fn; },
    onFocus: (fn: () => void) => { onFocus = fn; },
    setSnapshot: (s: any) => { pageSnapshot = s; }, blockGet: (wait?: () => Promise<void>) => { waitForTab = wait; } };
}

test('an unresponsive open bridge connection is replaced without replaying browser commands', async () => {
  const f = await fixture(); await f.call('connect', 1);
  const ws = f.sockets[0]; ws.open(); await ws.signal({ ready: true });
  f.clock.now += 20_000; f.tick();
  assert.equal(ws.replies.at(-1).ping, true);
  await ws.signal({ pong: true });
  f.clock.now += 40_000; f.tick();
  assert.equal(ws.readyState, 1, 'a recently responsive connection is preserved');
  f.clock.now += 20_000; f.tick();
  assert.equal(ws.readyState, 3, 'missing bridge replies must retire the stale socket');
  assert.equal((await f.call('status')).connected, false);
  assert.equal(f.sockets.length, 2);
  f.sockets[1].open(); await f.sockets[1].signal({ ready: true });
  assert.equal((await f.call('status')).connected, true);
  assert.equal(f.sent.length, 1, 'only the initial connect snapshot ran');
});

test('a connection stuck before opening is retired, and explicit disconnect cancels its watchdog', async () => {
  const f = await fixture(); await f.call('connect', 1);
  f.clock.now += 60_000; f.tick();
  assert.equal(f.sockets[0].readyState, 3);
  await f.call('status');
  assert.equal(f.sockets.length, 2);
  await f.call('disconnect');
  f.clock.now += 60_000; f.tick();
  await f.listeners.alarm({ name: 'reconnect' });
  assert.equal(f.sockets.length, 2);
  assert.equal(f.local.target.enabled, false);
});

test('sending from another task restores the hidden Chrome window before input', async () => {
  const f = await fixture(); await f.call('connect', 1); f.sockets[0].open();
  const binding = { url: 'https://chatgpt.com/c/old', baseline: [], marker: '[new]' };
  f.setSnapshot({ url: binding.url, ordinary: true, visible: false, draft: '', generating: false, messages: [] });
  f.setReply(msg => {
    if (msg.command === 'send') {
      assert.deepEqual(f.windows, [{ id: 7, state: 'normal', focused: true }]);
      return { value: { clicked: true } };
    }
  });
  await f.sockets[0].signal({ id: 'send', command: 'send', args: { text: '[new] review', binding } });
  assert.equal(f.sockets[0].replies.at(-1).value?.clicked, true);
});

test('a safe new command restores a minimized window before navigating', async () => {
  const f = await fixture(); await f.call('connect', 1); f.sockets[0].open();
  f.updated.length = 0; f.updates.length = 0;
  f.setSnapshot({ url: 'https://chatgpt.com/c/old', ordinary: true, draft: '', generating: false, messages: [] });
  await f.sockets[0].message('new');
  assert.deepEqual(f.updates, [
    { kind: 'tab', id: 1, active: true },
    { kind: 'window', id: 7, state: 'normal', focused: true },
    { kind: 'tab', id: 1, url: 'https://chatgpt.com/', active: true },
  ]);
  assert.equal(f.sockets[0].replies.at(-1).value?.navigating, true);
});

test('new does not reveal an occupied or mismatched tab and rechecks after focus', async () => {
  for (const change of [{ draft: 'manual question' }, { generating: true }, { url: 'https://chatgpt.com/c/other' }]) {
    const f = await fixture(); await f.call('connect', 1); f.sockets[0].open();
    f.updated.length = 0; f.updates.length = 0;
    f.setSnapshot({ url: 'https://chatgpt.com/c/old', draft: '', generating: false, messages: [], ...change });
    await f.sockets[0].message('new');
    assert.deepEqual(f.windows, []);
    assert.deepEqual(f.updated, []);
    assert.equal(f.sockets[0].replies.at(-1).error.code, 'CONTENT_UNAVAILABLE');
  }
  const f = await fixture(); await f.call('connect', 1); f.sockets[0].open();
  f.updated.length = 0; f.updates.length = 0;
  f.setSnapshot({ url: 'https://chatgpt.com/c/old', draft: '', generating: false, messages: [] });
  f.onFocus(() => f.setSnapshot({ url: 'https://chatgpt.com/c/old', draft: 'new manual draft', generating: false, messages: [] }));
  await f.sockets[0].message('new');
  assert.deepEqual(f.updated, [{ id: 1, active: true }]);
  assert.deepEqual(f.windows, [{ id: 7, state: 'normal', focused: true }]);
  assert.equal(f.sockets[0].replies.at(-1).error.code, 'CONTENT_UNAVAILABLE');
});

test('a stalled owned response reloads once and cancellation recovers a missing Stop control', async () => {
  const f = await fixture(); await f.call('connect', 1); f.sockets[0].open();
  const binding = { url: 'https://chatgpt.com/c/old', userId: 'u1', marker: '[owned]' };
  const state = { url: binding.url, ordinary: true, visible: true, draft: '', generating: true, canStop: false,
    messages: [{ id: 'u1', role: 'user', text: '[owned] review' }, { id: 'a1', role: 'assistant', text: 'partial', complete: false }] };
  f.setSnapshot(state);
  const poll = () => f.sockets[0].signal({ id: 'poll', command: 'snapshot', args: { binding } });
  await poll(); f.clock.now += 31_000; await poll(); await poll();
  assert.deepEqual(f.pageReloads, [1]);
  let done = false;
  f.onReload(() => { done = true; f.setSnapshot({ ...state, generating: false, canStop: false }); });
  f.setReply(msg => msg.command === 'cancel' ? done ? { value: { cancelled: true } } : { error: { code: 'STOP_UNAVAILABLE' } } : undefined);
  await f.sockets[0].signal({ id: 'cancel', command: 'cancel', args: { binding } });
  assert.equal(f.sockets[0].replies.at(-1).value?.cancelled, true);
  assert.equal(f.pageReloads.length, 2);
});

test('stalled recovery preserves drafts and never reloads another tasks conversation', async () => {
  const f = await fixture(); await f.call('connect', 1); f.sockets[0].open();
  const binding = { url: 'https://chatgpt.com/c/old', userId: 'u1', marker: '[owned]' };
  const state = { url: binding.url, ordinary: true, visible: true, draft: '', generating: true, canStop: false,
    messages: [{ id: 'u1', role: 'user', text: '[owned]' }, { id: 'a1', role: 'assistant', text: 'partial' }] };
  for (const change of [{ draft: 'user draft' }, { url: 'https://chatgpt.com/c/other' },
    { messages: [{ id: 'u2', role: 'user', text: '[other]' }] }]) {
    f.setSnapshot({ ...state, ...change });
    await f.sockets[0].signal({ id: 'poll', command: 'snapshot', args: { binding } });
    f.clock.now += 31_000;
    await f.sockets[0].signal({ id: 'poll', command: 'snapshot', args: { binding } });
    f.setReply(msg => msg.command === 'cancel' ? { error: { code: 'STOP_UNAVAILABLE' } } : undefined);
    await f.sockets[0].signal({ id: 'cancel', command: 'cancel', args: { binding } });
    assert.equal(f.pageReloads.length, 0);
  }
});

test('cancellation rechecks ownership after reloading and has a bounded recovery window', async () => {
  for (const navigated of [true, false]) {
    const f = await fixture(); await f.call('connect', 1); f.sockets[0].open();
    const binding = { url: 'https://chatgpt.com/c/old', userId: 'u1', marker: '[owned]' };
    const state = { url: binding.url, ordinary: true, visible: true, draft: '', generating: true,
      messages: [{ id: 'u1', role: 'user', text: '[owned]' }] };
    f.setSnapshot(state);
    let cancels = 0;
    f.setReply(msg => { if (msg.command === 'cancel') { cancels++; return { error: { code: 'STOP_UNAVAILABLE' } }; } });
    f.onReload(() => f.setSnapshot({ ...state, ...(navigated ? { url: 'https://chatgpt.com/c/other' } : { ordinary: false }) }));
    const started = f.clock.now;
    await f.sockets[0].signal({ id: 'cancel', command: 'cancel', args: { binding }, expiresAt: started + 15_000 });
    assert.equal(f.sockets[0].replies.at(-1).error.code, navigated ? 'NOT_OWNER' : 'STOP_UNAVAILABLE');
    assert.equal(cancels, 1);
    assert.deepEqual(f.pageReloads, [1]);
    assert.ok(f.clock.now - started <= 10_000);
  }
});

test('recovery handles a stall before the first assistant token', async () => {
  const f = await fixture(); await f.call('connect', 1); f.sockets[0].open();
  const binding = { url: 'https://chatgpt.com/c/old', userId: 'u1', marker: '[owned]' };
  f.setSnapshot({ url: binding.url, ordinary: true, visible: true, draft: '', generating: false, canStop: false,
    messages: [{ id: 'u1', role: 'user', text: '[owned]' }] });
  const poll = () => f.sockets[0].signal({ id: 'poll', command: 'snapshot', args: { binding } });
  await poll(); f.clock.now += 31_000; await poll();
  assert.deepEqual(f.pageReloads, [1]);
});

test('cancellation waits for message hydration and avoids reloading a naturally completed response', async () => {
  for (const completed of [false, true]) {
    const f = await fixture(); await f.call('connect', 1); f.sockets[0].open();
    const binding = { url: 'https://chatgpt.com/c/old', userId: 'u1', marker: '[owned]' };
    const state = { url: binding.url, ordinary: true, visible: true, draft: '', generating: true, canStop: false,
      messages: [{ id: 'u1', role: 'user', text: '[owned]' }] };
    f.setSnapshot(state);
    let loading = false, reads = 0;
    f.onReload(() => { loading = true; });
    f.setReply(msg => {
      if (msg.command === 'cancel') {
        if (completed) f.setSnapshot({ ...state, generating: false });
        return { error: { code: 'STOP_UNAVAILABLE' } };
      }
      if (loading && msg.command === 'snapshot') return { value: ++reads === 1 ? { ...state, messages: [] } : { ...state, generating: false } };
    });
    await f.sockets[0].signal({ id: 'cancel', command: 'cancel', args: { binding } });
    assert.equal(f.sockets[0].replies.at(-1).value?.cancelled, true);
    assert.equal(f.pageReloads.length, completed ? 0 : 1);
  }
});

test('an accepted Stop is not reported complete while its rendering is still stuck', async () => {
  const f = await fixture(); await f.call('connect', 1); f.sockets[0].open();
  const binding = { url: 'https://chatgpt.com/c/old', userId: 'u1', marker: '[owned]' };
  const state = { url: binding.url, ordinary: true, visible: true, draft: '', generating: true, canStop: false,
    messages: [{ id: 'u1', role: 'user', text: '[owned]' }] };
  f.setSnapshot(state);
  f.setReply(msg => msg.command === 'cancel' ? { value: { cancelled: true } } : undefined);
  f.onReload(() => f.setSnapshot({ ...state, generating: false }));
  await f.sockets[0].signal({ id: 'cancel', command: 'cancel', args: { binding } });
  assert.deepEqual(f.pageReloads, [1]);
  assert.equal(f.sockets[0].replies.at(-1).value?.cancelled, true);
});

test('a Stop control restored by reloading is used before confirming cancellation', async () => {
  const f = await fixture(); await f.call('connect', 1); f.sockets[0].open();
  const binding = { url: 'https://chatgpt.com/c/old', userId: 'u1', marker: '[owned]' };
  const state = { url: binding.url, ordinary: true, visible: true, draft: '', generating: true, canStop: false,
    messages: [{ id: 'u1', role: 'user', text: '[owned]' }] };
  f.setSnapshot(state);
  let calls = 0;
  f.onReload(() => f.setSnapshot({ ...state, canStop: true }));
  f.setReply(msg => {
    if (msg.command === 'cancel') {
      if (++calls === 1) return { error: { code: 'STOP_UNAVAILABLE' } };
      f.setSnapshot({ ...state, generating: false });
      return { value: { cancelled: true } };
    }
  });
  await f.sockets[0].signal({ id: 'cancel', command: 'cancel', args: { binding } });
  assert.equal(f.sockets[0].replies.at(-1).value?.cancelled, true);
  assert.equal(calls, 2);
});

test('a sent request can be cancelled while preserving the users next draft', async () => {
  const f = await fixture(); await f.call('connect', 1); f.sockets[0].open();
  const binding = { url: 'https://chatgpt.com/c/old', userId: 'u1', marker: '[owned]' };
  const state = { url: binding.url, ordinary: true, visible: true, draft: 'next question', generating: true, canStop: true,
    messages: [{ id: 'u1', role: 'user', text: '[owned]' }] };
  f.setSnapshot(state);
  f.setReply(msg => {
    if (msg.command === 'cancel') { f.setSnapshot({ ...state, generating: false }); return { value: { cancelled: true } }; }
  });
  await f.sockets[0].signal({ id: 'cancel', command: 'cancel', args: { binding } });
  assert.equal(f.sockets[0].replies.at(-1).value?.cancelled, true);
  assert.equal(f.pageReloads.length, 0);
});

test('a command that expires while locating the tab never reaches its content script', async () => {
  const f = await fixture();
  await f.call('connect', 1); f.sockets[0].open(); f.sent.length = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.blockGet(() => gate);
  const pending = f.sockets[0].signal({ id: 'expired', command: 'send', expiresAt: f.clock.now + 15_000 });
  f.clock.now += 15_001;
  release(); await pending;
  assert.equal(f.sent.length, 0);
  assert.equal(f.sockets[0].replies.at(-1).error.code, 'COMMAND_EXPIRED');
});

test('only an owned response poll reveals a hidden ChatGPT tab', async () => {
  const f = await fixture();
  await f.call('connect', 1); f.sockets[0].open(); f.updated.length = 0;
  const binding = { url: 'https://chatgpt.com/c/old', userId: 'u1', marker: '[owned]' };
  const state = { url: binding.url, visible: false, ordinary: true, draft: '', generating: true,
    messages: [{ id: 'u1', role: 'user', text: '[owned] question' }] };
  f.setSnapshot(state);
  await f.sockets[0].signal({ id: 'health', command: 'snapshot' });
  assert.equal(f.updated.length, 0);
  for (const changed of [{ url: 'https://chatgpt.com/c/other' }, { ordinary: false },
    { visible: true }, { messages: [{ id: 'u2', role: 'user', text: 'manual' }] }]) {
    f.setSnapshot({ ...state, ...changed });
    await f.sockets[0].signal({ id: 'changed', command: 'snapshot', args: { binding } });
    assert.equal(f.updated.length, 0);
  }
  f.setSnapshot(state);
  await f.sockets[0].signal({ id: 'owned', command: 'snapshot', args: { binding } });
  assert.deepEqual(f.updated, [{ id: 1, active: true }]);
});

test('first install opens and connects its own tab without changing existing chats', async () => {
  const f = await fixture();
  await f.listeners.installed({ reason: 'install' });
  const status = await f.call('status');
  assert.equal(status.tabId, 11);
  assert.equal(f.pages.get(1)!.url, 'https://chatgpt.com/c/old');
  assert.equal(f.local.target.enabled, true);
  assert.equal(f.sockets.length, 1);
  f.sockets[0].open();
  await f.sockets[0].message('snapshot');
  assert.deepEqual(f.injected, [11]);
});

test('existing pages need no refresh and injection happens only when the listener is missing', async () => {
  const f = await fixture();
  assert.equal((await f.call('connect', 1)).tabId, 1);
  assert.deepEqual(f.injected, [1]);
  f.sockets[0].open();
  await f.sockets[0].message('snapshot');
  assert.deepEqual(f.injected, [1]);
});

test('restart recovers the saved conversation, while explicit disconnect stays disconnected', async () => {
  const f = await fixture({ target: { enabled: true, url: 'https://chatgpt.com/c/old' } });
  assert.equal((await f.call('status')).tabId, 1);
  assert.equal(f.pages.size, 1);
  await f.call('disconnect');
  const next = await fixture(f.local);
  await next.listeners.installed({ reason: 'update' });
  assert.equal((await next.call('status')).tabId, undefined);
  assert.equal(next.sockets.length, 0);
});

test('other tabs and same-tab ChatGPT navigation preserve the selected connection', async () => {
  const f = await fixture(); await f.call('connect', 1);
  f.sockets[0].open(); await f.sockets[0].signal({ ready: true });
  f.listeners.updated(2, { status: 'complete' }, { id: 2, url: 'https://chatgpt.com/' });
  f.listeners.removed(2, { isWindowClosing: false });
  f.listeners.replaced(3, 2);
  f.listeners.updated(1, { url: 'https://chatgpt.com/c/new' }, { id: 1, url: 'https://chatgpt.com/c/new' });
  const status = await f.call('status');
  assert.equal(status.tabId, 1); assert.equal(status.connected, true);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.local.target.url, 'https://chatgpt.com/c/new');
});

test('Chrome tab replacement reconnects the replacement and ignores removal of the old ID', async () => {
  const f = await fixture({}, {}, [{ id: 1, url: 'https://chatgpt.com/c/old' }, { id: 2, url: 'https://chatgpt.com/c/old' }]);
  await f.call('connect', 1); f.sockets[0].open();
  f.listeners.replaced(2, 1);
  f.listeners.removed(1, { isWindowClosing: false });
  await f.call('status');
  assert.equal((await f.call('status')).tabId, 2);
  assert.equal(f.sockets[0].readyState, 3);
  f.sockets[1].open(); await f.sockets[1].signal({ ready: true });
  assert.equal((await f.call('status')).connected, true);
  assert.equal(f.local.target.enabled, true);
});

test('a failed tab replacement releases its selection so another tab can connect', async () => {
  const f = await fixture(); await f.call('connect', 1); f.sockets[0].open();
  await f.listeners.replaced(999, 1);
  assert.equal((await f.call('status')).tabId, undefined);
  assert.equal(f.sockets[0].readyState, 3);
  assert.equal((await f.call('connect', 1)).tabId, 1);
});

test('a late tab replacement failure does not disconnect a newly selected tab', async () => {
  const f = await fixture(); await f.call('connect', 1); f.sockets[0].open();
  let reject!: (error: Error) => void;
  f.blockGet(() => new Promise<void>((_, fail) => { reject = fail; }));
  const replaced = f.listeners.replaced(999, 1);
  await f.call('disconnect'); f.blockGet();
  await f.call('connect', 1);
  reject(Error('Old tab disappeared')); await replaced;
  assert.equal((await f.call('status')).tabId, 1);
  assert.equal(f.local.target.enabled, true);
});

test('ambiguous restored tabs are not selected and closing Chrome preserves automatic reconnect', async () => {
  const f = await fixture({ target: { enabled: true, url: 'https://chatgpt.com/c/old' } }, {}, [
    { id: 1, url: 'https://chatgpt.com/c/old' }, { id: 2, url: 'https://chatgpt.com/c/old' },
  ]);
  assert.equal((await f.call('status')).tabId, 12);
  f.listeners.removed(12, { isWindowClosing: true });
  await f.call('status');
  assert.equal(f.local.target.enabled, true);
});

test('disconnecting while a command is pending cannot send it to a newly selected tab', async () => {
  const f = await fixture({}, {}, [{ id: 1, url: 'https://chatgpt.com/c/old' }, { id: 2, url: 'https://chatgpt.com/c/new' }]);
  await f.call('connect', 1); f.sockets[0].open();
  f.sent.length = 0; f.updated.length = 0;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.blockGet(() => blocked);
  const command = f.sockets[0].message('new');
  await f.call('disconnect');
  f.blockGet();
  await f.call('connect', 2); f.sockets[1].open();
  release(); await command;
  assert.deepEqual(f.sent, [2]);
  assert.deepEqual(f.updated.filter(change => change.url), []);
  assert.equal((await f.call('status')).tabId, 2);
});

test('an installed update reloads automatically after the active browser command finishes', async () => {
  const f = await fixture();
  await f.call('connect', 1); f.sockets[0].open();
  await f.sockets[0].signal({ pong: true, revision: 'fixture' });
  assert.equal(f.reloads.count, 0);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.blockGet(() => blocked);
  const command = f.sockets[0].message('snapshot');
  await f.sockets[0].signal({ pong: true, revision: 'updated' });
  assert.equal(f.reloads.count, 0);
  release(); await command;
  assert.equal(f.reloads.count, 1);
});

test('leaving ChatGPT disconnects even when Chrome withholds the new URL', async () => {
  const f = await fixture();
  await f.call('connect', 1);
  f.listeners.updated(1, { status: 'complete' }, { id: 1 });
  await f.call('status');
  assert.equal((await f.call('status')).tabId, undefined);
  assert.equal(f.local.target.enabled, false);
});

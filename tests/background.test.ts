import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

async function fixture(local: any = {}, session: any = {}, tabs = [{ id: 1, url: 'https://chatgpt.com/c/old' }]) {
  const sent: number[] = [], injected: number[] = [], updated: any[] = [], sockets: Socket[] = [];
  const listeners: any = {}, pages = new Map(tabs.map(tab => [tab.id, tab])), reloads = { count: 0 };
  const loaded = new Set<number>();
  let waitForTab: (() => Promise<void>) | undefined;
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 0;
    onopen?: () => void; onclose?: () => void; onmessage?: (e: { data: string }) => Promise<void>;
    constructor() { sockets.push(this); }
    send() {}
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
    tabs: {
      get: async (id: number) => { if (waitForTab) await waitForTab(); const tab = pages.get(id); if (!tab) throw Error('No tab'); return tab; },
      query: async () => [...pages.values()],
      create: async ({ url }: any) => { const tab = { id: 10 + pages.size, url }; pages.set(tab.id, tab); return tab; },
      sendMessage: async (id: number) => { if (!loaded.has(id)) throw Error('No receiver'); sent.push(id); return { value: { url: pages.get(id)!.url, draft: '', generating: false } }; },
      update: async (id: number, change: any) => { updated.push({ id, ...change }); return pages.get(id); },
      onRemoved: event('removed'), onUpdated: event('updated'),
    },
  };
  const source = (await readFile('extension/background.js', 'utf8')).replace("import { token, revision } from './config.js';", "const token = 'fixture', revision = 'fixture';");
  runInNewContext(source, { chrome, WebSocket: Socket, setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {} });
  const call = (command: string, tabId?: number) => new Promise<any>(resolve => listeners.message({ command, tabId }, {}, resolve));
  await call('status');
  return { call, listeners, pages, sent, injected, updated, sockets, local, reloads, blockGet: (wait?: () => Promise<void>) => { waitForTab = wait; } };
}

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

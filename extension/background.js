import { token, revision } from './config.js';
const home = 'https://chatgpt.com/';
const isChat = tab => tab.url?.startsWith(home);
let socket, tabId, reconnect, connected = false, connectionError;
let running = 0, reloadPending = false;
let progress;
const owns = (s, b) => {
  const user = s?.messages?.filter(m => m.role === 'user').at(-1);
  return !!(b?.userId && s?.ordinary && s.url === b.url && user?.id === b.userId && user.text.includes(b.marker));
};
const reloadable = (s, b) => owns(s, b) && !s.draft.trim() && /^https:\/\/chatgpt\.com\/c\/(?!WEB:|local-chatgpt(?::|%3a))[^/?#]+$/i.test(s.url);
function applyUpdate() {
  if (reloadPending && !running) { reloadPending = false; chrome.runtime.reload(); }
}
async function snapshot(target) {
  try { return await chrome.tabs.sendMessage(target, { command: 'snapshot' }); }
  catch {
    // Tabs that predate installation have no content script yet.
    await chrome.scripting.executeScript({ target: { tabId: target }, files: ['content.js'] });
    return chrome.tabs.sendMessage(target, { command: 'snapshot' });
  }
}
function connect() {
  if (!tabId || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  const target = tabId;
  const ws = new WebSocket('ws://127.0.0.1:9234/extension');
  socket = ws;
  const current = () => socket === ws && tabId === target;
  const reply = value => { if (current() && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
  let heartbeat;
  ws.onopen = () => {
    if (!current()) { ws.close(); return; }
    reply({ token, revision });
    heartbeat = setInterval(() => reply({ ping: true }), 20_000);
  };
  ws.onmessage = async event => {
    if (!current()) return;
    let msg;
    try { msg = JSON.parse(event.data); } catch { ws.close(); return; }
    if (msg.revision && msg.revision !== revision) { reloadPending = true; applyUpdate(); }
    if (msg.ready) { connected = true; return; }
    if (!msg.id) return;
    const checkDeadline = () => {
      if (msg.expiresAt !== undefined && Date.now() >= msg.expiresAt)
        throw Object.assign(Error('Browser command expired before execution.'), { code: 'COMMAND_EXPIRED' });
    };
    running++;
    try {
      checkDeadline();
      const tab = await chrome.tabs.get(target);
      if (!current()) return;
      checkDeadline();
      if (!isChat(tab)) throw Error('Connected tab left ChatGPT.');
      let before = await snapshot(target);
      if (!current()) return;
      checkDeadline();
      const b = msg.args?.binding;
      let s = before.value;
      const preparing = ['configure', 'send'].includes(msg.command) && b && s?.ordinary && s.url === b.url &&
        !s.draft.trim() && !s.generating && JSON.stringify(s.messages.map(m => m.id)) === JSON.stringify(b.baseline);
      const safeNew = msg.command === 'new' && !before.error && typeof msg.args?.expectedUrl === 'string' &&
        s?.url === msg.args.expectedUrl && typeof s.draft === 'string' && !s.draft.trim() && !s.generating;
      // Selecting a tab alone does not restore a minimized Chrome window.
      if (preparing || safeNew || (owns(s, b) && (s.visible === false || msg.command === 'cancel'))) {
        await chrome.tabs.update(target, { active: true });
        if (!current()) return;
        checkDeadline();
        const window = await chrome.windows.get(tab.windowId);
        if (!current()) return;
        checkDeadline();
        await chrome.windows.update(tab.windowId, { ...(window.state === 'minimized' ? { state: 'normal' } : {}), focused: true });
        if (!current()) return;
        checkDeadline();
        before = await snapshot(target); s = before.value;
        if (!current()) return;
      }
      let value;
      checkDeadline();
      if (msg.command === 'snapshot' && reloadable(s, b) && s.visible !== false && s.canStop === false) {
        const answer = s.messages.slice(s.messages.findIndex(m => m.id === b.userId) + 1).filter(m => m.role === 'assistant').at(-1);
        if (!answer?.complete) {
          const key = b.url + b.userId;
          const text = answer?.text || '';
          if (progress?.key !== key) progress = { key, text, since: Date.now(), reloaded: false };
          if (progress.text !== text) { progress.text = text; progress.since = Date.now(); }
          if (!progress.reloaded && Date.now() - progress.since >= 30_000) {
            progress.reloaded = true;
            await chrome.tabs.reload(target);
          }
        }
      } else if (msg.command === 'snapshot' && owns(s, b) && progress?.key === b.url + b.userId) {
        progress.since = Date.now();
      }
      if (msg.command === 'new') {
        if (before.error || before.value.url !== msg.args.expectedUrl || before.value.draft.trim() || before.value.generating)
          throw Error('Target changed or composer occupied.');
        await chrome.tabs.update(target, { url: home, active: true });
        value = { navigating: true };
      } else {
        let response = msg.command === 'snapshot' ? before : await chrome.tabs.sendMessage(target, msg);
        if (msg.command === 'cancel' && b?.userId && (response.value?.cancelled || response.error?.code === 'STOP_UNAVAILABLE')) {
          const limit = Math.min(msg.expiresAt ?? Infinity, Date.now() + 10_000), settle = Date.now() + 1_000;
          let reloaded = false, stopped = !!response.value?.cancelled, confirmed = false;
          while (current() && Date.now() < limit) {
            checkDeadline();
            let ready;
            try { ready = (await snapshot(target)).value; } catch { /* Navigation may temporarily remove the listener. */ }
            if (!current()) return;
            checkDeadline();
            const user = ready?.messages?.filter(m => m.role === 'user').at(-1);
            if ((ready?.url && ready.url !== b.url) ||
                (ready?.messages?.some(m => m.id === b.userId) && user?.id !== b.userId))
              throw Object.assign(Error('Request ownership changed during cancellation.'), { code: 'NOT_OWNER' });
            if (owns(ready, b)) {
              if (!ready.generating) { confirmed = true; response = { value: { cancelled: true } }; break; }
              const noStop = ready.canStop === false || (ready.canStop === undefined && response.error?.code === 'STOP_UNAVAILABLE');
              if (!reloaded && reloadable(ready, b) && noStop && (!stopped || Date.now() >= settle)) {
                await chrome.tabs.reload(target); reloaded = true; stopped = false;
              } else if (!stopped && !noStop) {
                response = await chrome.tabs.sendMessage(target, msg);
                stopped = !!response.value?.cancelled;
                if (response.error && !['STOP_UNAVAILABLE', 'CONTENT_UNAVAILABLE'].includes(response.error.code)) break;
              }
            }
            await new Promise(resolve => setTimeout(resolve, 200));
          }
          if (!confirmed && !response.error) response = { error: { code: 'STOP_UNAVAILABLE', message: 'Cancellation was requested but the page has not confirmed that generation stopped. Retry cancellation with the same request ID.' } };
        }
        reply({ ...response, id: msg.id });
        return;
      }
      reply({ id: msg.id, value });
    } catch (error) {
      reply({ id: msg.id, error: { code: error.code || 'CONTENT_UNAVAILABLE', message: String(error) } });
    } finally { running--; applyUpdate(); }
  };
  ws.onclose = () => { clearInterval(heartbeat); if (socket === ws) { socket = undefined; connected = false; if (tabId) reconnect = setTimeout(connect, 3_000); } };
  ws.onerror = () => ws.close();
}
async function disconnect(remember = true) {
  const ws = socket;
  tabId = undefined;
  socket = undefined;
  connected = false;
  clearTimeout(reconnect);
  ws?.close();
  await chrome.storage.session.remove('tabId');
  if (remember) await chrome.storage.local.set({ target: { enabled: false } });
  await chrome.alarms.clear('reconnect');
}
async function attach(tab) {
  if (!isChat(tab)) throw Error('Open a ChatGPT tab before connecting.');
  if (tabId && tabId !== tab.id) throw Error('Disconnect the previous tab first.');
  await chrome.tabs.update(tab.id, { autoDiscardable: false });
  tabId = tab.id; connectionError = undefined;
  await chrome.storage.session.set({ tabId });
  await chrome.storage.local.set({ target: { enabled: true, url: tab.url } });
  await chrome.alarms.create('reconnect', { periodInMinutes: 1 });
  connect();
}
async function openChat(active = true) {
  if (tabId) return chrome.tabs.update(tabId, { active });
  const tab = await chrome.tabs.create({ url: home, active });
  await attach({ ...tab, url: home });
}
async function restore() {
  const { tabId: saved } = await chrome.storage.session.get('tabId');
  const { target } = await chrome.storage.local.get('target');
  if (target?.enabled === false) return;
  if (saved) {
    try { const tab = await chrome.tabs.get(saved); if (isChat(tab)) { await attach(tab); return; } }
    catch { /* Chrome may assign new tab IDs after a restart. */ }
  }
  if (!target?.enabled) return;
  const matches = (await chrome.tabs.query({ url: home + '*' })).filter(tab => tab.url === target.url);
  if (matches.length === 1) await attach(matches[0]);
  else await openChat(false);
}
const restored = restore().catch(e => { connectionError = String(e); });
chrome.runtime.onInstalled.addListener(details => {
  return (async () => {
    await restored;
    const { target } = await chrome.storage.local.get('target');
    if (tabId || target?.enabled === false) return;
    // Preserve a single existing ChatGPT tab when upgrading the manual version.
    const tabs = details.reason === 'update' ? await chrome.tabs.query({ url: home + '*' }) : [];
    if (tabs.length === 1) await attach(tabs[0]);
    else await openChat();
  })().catch(e => { connectionError = String(e); });
});
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.tab) return;
  (async () => {
    await restored;
    if (msg.command === 'connect') {
      const tab = await chrome.tabs.get(msg.tabId);
      if (!isChat(tab)) throw Error('Open a ChatGPT tab before connecting.');
      if (tabId && tabId !== tab.id) throw Error('Disconnect the previous tab first.');
      await snapshot(tab.id);
      await attach(tab);
    } else if (msg.command === 'open') {
      await openChat();
    } else if (msg.command === 'disconnect') {
      await disconnect();
    }
    if (tabId) await connect();
    reply({ tabId, connected, error: connectionError });
  })().catch(e => reply({ error: String(e) }));
  return true;
});
chrome.tabs.onRemoved.addListener((id, info) => { if (id === tabId) void disconnect(!info.isWindowClosing); });
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (id !== tabId) return;
  if (change.url || change.status === 'complete') {
    if (!isChat(tab)) void disconnect();
    else void chrome.storage.local.set({ target: { enabled: true, url: tab.url } });
  }
});
chrome.alarms.onAlarm.addListener(async alarm => { await restored; if (alarm.name === 'reconnect') connect(); });

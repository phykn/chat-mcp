import { token, revision } from './config.js';
import { home, isChat, PageCommands } from './page.js';
const page = new PageCommands();
let socket, tabId, reconnect, connected = false, connectionError;
let running = 0, reloadPending = false;
function applyUpdate() {
  if (reloadPending && !running) { reloadPending = false; chrome.runtime.reload(); }
}
function connect() {
  if (!tabId || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  const target = tabId;
  const ws = new WebSocket('ws://127.0.0.1:9234/extension');
  socket = ws;
  const current = () => socket === ws && tabId === target;
  const reply = value => { if (current() && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
  let lastReply = Date.now();
  const heartbeat = setInterval(() => {
    if (!current()) { clearInterval(heartbeat); return; }
    if (Date.now() - lastReply >= 60_000) {
      socket = undefined; connected = false;
      clearInterval(heartbeat);
      ws.close();
      reconnect = setTimeout(connect, 3_000);
      return;
    }
    reply({ ping: true });
  }, 20_000);
  ws.onopen = () => {
    if (!current()) { ws.close(); return; }
    reply({ token, revision });
  };
  ws.onmessage = async event => {
    if (!current()) return;
    let msg;
    try { msg = JSON.parse(event.data); } catch { ws.close(); return; }
    lastReply = Date.now();
    if (msg.revision && msg.revision !== revision) { reloadPending = true; applyUpdate(); }
    if (msg.ready) { connected = true; return; }
    if (!msg.id) return;
    running++;
    try {
      const response = await page.execute(msg, target, current);
      if (response) reply({ ...response, id: msg.id });
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
      await page.snapshot(tab.id);
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
chrome.tabs.onReplaced.addListener((added, removed) => {
  if (removed !== tabId) return;
  const ws = socket;
  tabId = added; socket = undefined; connected = false;
  clearTimeout(reconnect); ws?.close();
  return (async () => {
    const tab = await chrome.tabs.get(added);
    if (tabId !== added) return;
    if (isChat(tab)) await attach(tab);
    else await disconnect();
  })().catch(async e => {
    if (tabId !== added) return;
    await disconnect();
    connectionError = String(e);
  });
});
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (id !== tabId) return;
  if (change.url || change.status === 'complete') {
    if (!isChat(tab)) void disconnect();
    else void chrome.storage.local.set({ target: { enabled: true, url: tab.url } });
  }
});
chrome.alarms.onAlarm.addListener(async alarm => { await restored; if (alarm.name === 'reconnect') connect(); });

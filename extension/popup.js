const status = document.querySelector('#status');
const connect = document.querySelector('#connect');
const disconnect = document.querySelector('#disconnect');
async function run(command) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const result = await chrome.runtime.sendMessage({ command, tabId: tab?.id });
  status.textContent = result.error || (result.connected ? 'Connected. Keep ChatGPT signed in.'
    : result.tabId ? 'Waiting for Codex. The connection starts automatically when Chat MCP is used.'
    : 'Click Open ChatGPT to connect automatically.');
  connect.hidden = !!result.tabId || !tab?.url?.startsWith('https://chatgpt.com/');
  connect.disabled = !!result.tabId;
  disconnect.disabled = !result.tabId;
}
const showError = e => { status.textContent = e.message || String(e); };
connect.onclick = () => run('connect').catch(showError);
document.querySelector('#open').onclick = () => run('open').catch(showError);
disconnect.onclick = () => run('disconnect').catch(showError);
run('status').catch(showError);
setInterval(() => run('status').catch(showError), 1_000);

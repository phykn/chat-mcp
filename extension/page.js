export const home = 'https://chatgpt.com/';
export const isChat = tab => tab.url?.startsWith(home);
const owns = (s, b) => {
  const user = s?.messages?.filter(m => m.role === 'user').at(-1);
  return !!(b?.userId && s?.ordinary && s.url === b.url && user?.id === b.userId && user.text.includes(b.marker));
};
const reloadable = (s, b) => owns(s, b) && !s.draft.trim() && /^https:\/\/chatgpt\.com\/c\/(?!WEB:|local-chatgpt(?::|%3a))[^/?#]+$/i.test(s.url);

export class PageCommands {
  async snapshot(target) {
    try { return await chrome.tabs.sendMessage(target, { command: 'snapshot' }); }
    catch {
      // Tabs that predate installation have no content script yet.
      await chrome.scripting.executeScript({ target: { tabId: target }, files: ['content.js'] });
      return chrome.tabs.sendMessage(target, { command: 'snapshot' });
    }
  }

  async execute(msg, target, current) {
    const checkDeadline = () => {
      if (msg.expiresAt !== undefined && Date.now() >= msg.expiresAt)
        throw Object.assign(Error('Browser command expired before execution.'), { code: 'COMMAND_EXPIRED' });
    };
    checkDeadline();
    const tab = await chrome.tabs.get(target);
    if (!current()) return;
    checkDeadline();
    if (!isChat(tab)) throw Error('Connected tab left ChatGPT.');
    // Preparation must wake the renderer before waiting for a page response.
    if (msg.command === 'snapshot' && msg.args?.activate === true &&
        (!msg.args.binding || tab.url === msg.args.binding.url)) {
      if (!await this.wake(target, tab.windowId, current, checkDeadline)) return;
    }
    let before = await this.snapshot(target);
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
      if (!await this.wake(target, tab.windowId, current, checkDeadline)) return;
      before = await this.snapshot(target); s = before.value;
      if (!current()) return;
    }
    let value;
    checkDeadline();
    if (msg.command === 'snapshot' && reloadable(s, b) && s.visible !== false && s.canStop === false) {
      const answer = s.messages.slice(s.messages.findIndex(m => m.id === b.userId) + 1).filter(m => m.role === 'assistant').at(-1);
      if (!answer?.complete) {
        const key = b.url + b.userId;
        const text = answer?.text || '';
        if (this.progress?.key !== key) this.progress = { key, text, since: Date.now(), reloaded: false };
        if (this.progress.text !== text) { this.progress.text = text; this.progress.since = Date.now(); }
        if (!this.progress.reloaded && Date.now() - this.progress.since >= 30_000) {
          this.progress.reloaded = true;
          await chrome.tabs.reload(target);
        }
      }
    } else if (msg.command === 'snapshot' && owns(s, b) && this.progress?.key === b.url + b.userId) {
      this.progress.since = Date.now();
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
          try { ready = (await this.snapshot(target)).value; } catch { /* Navigation may temporarily remove the listener. */ }
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
      return response;
    }
    return { value };
  }

  async wake(target, windowId, current, checkDeadline) {
    await chrome.tabs.update(target, { active: true });
    if (!current()) return false;
    checkDeadline();
    const window = await chrome.windows.get(windowId);
    if (!current()) return false;
    checkDeadline();
    await chrome.windows.update(windowId, { ...(window.state === 'minimized' ? { state: 'normal' } : {}), focused: true });
    if (!current()) return false;
    checkDeadline();
    return true;
  }
}

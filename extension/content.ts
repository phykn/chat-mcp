import { browserSnapshot, stopButton, composer, sendButton } from '../src/adapters/dom.js';
import { normalizeDraft, maxInputLines } from '../src/core/text.js';
import { checkReasoning, configureReasoning } from '../src/adapters/reasoning.js';
declare const chrome: any;
let busy = false;
const fault = (code: string, message: string) => Object.assign(new Error(message), { code });
const sameBaseline = (ids: string[], baseline: string[]) => JSON.stringify(ids) === JSON.stringify(baseline);
async function fingerprint(text: string) {
  const bytes = new TextEncoder().encode(JSON.stringify(normalizeDraft(text)));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
}
async function waitForInput(text: string) {
  await Promise.resolve();
  if (normalizeDraft(browserSnapshot().draft) !== normalizeDraft(text))
    throw fault('INPUT_MISMATCH', 'Input readback differs; send was not clicked.');
  const ready = () => normalizeDraft(browserSnapshot().draft) === normalizeDraft(text) && !!sendButton();
  if (ready()) return;
  // Mutation events work in background tabs; a short timer can be throttled for a minute.
  await new Promise<void>(resolve => {
    const done = () => { observer.disconnect(); clearTimeout(timer); resolve(); };
    const observer = new MutationObserver(() => { if (ready()) done(); });
    const timer = setTimeout(done, 5_000);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    if (ready()) done();
  });
}
async function execute(msg: any) {
  if (msg.command === 'snapshot') return browserSnapshot();
  const checkDeadline = () => {
    if (msg.expiresAt !== undefined && Date.now() >= msg.expiresAt)
      throw fault('COMMAND_EXPIRED', 'Browser command expired before execution; send was not clicked.');
  };
  checkDeadline();
  if (busy) throw fault('BUSY', 'Another input operation is running.');
  busy = true;
  try {
    const b = msg.args.binding, s = browserSnapshot();
    if (!s.ordinary || s.url !== b.url) throw fault('CONVERSATION_CHANGED', 'Current tab is not the managed ordinary Chat.');
    if (msg.command === 'configure') {
      const check = () => {
        checkDeadline();
        const now = browserSnapshot();
        if (!now.ordinary || now.url !== b.url || now.generating || now.draft.trim() ||
            !sameBaseline(now.messages.map(m => m.id), b.baseline))
          throw fault('CONVERSATION_CHANGED', 'Composer changed during reasoning configuration.');
      };
      await configureReasoning(msg.args.reasoning_effort, check);
      check();
      return browserSnapshot();
    }
    if (msg.command === 'cancel') {
      if (!b.userId) {
        if (s.generating || !b.draftHash || !sameBaseline(s.messages.map(m => m.id), b.baseline))
          throw fault('NOT_OWNER', 'No unchanged draft belonging to this request is visible.');
        // A previous cancellation may have cleared the draft before its reply was lost.
        if (!s.draft.trim()) return { cancelled: true };
        if (await fingerprint(s.draft) !== b.draftHash)
          throw fault('NOT_OWNER', 'No unchanged draft belonging to this request is visible.');
        // Hashing yields to the page: the user may type or switch chats meanwhile.
        const after = browserSnapshot();
        checkDeadline();
        if (!after.ordinary || after.url !== s.url || after.generating || after.draft !== s.draft ||
            !sameBaseline(after.messages.map(m => m.id), b.baseline))
          throw fault('NOT_OWNER', 'The draft or conversation changed during cancellation.');
        const editor = composer()!;
        editor.focus();
        const range = document.createRange(); range.selectNodeContents(editor);
        const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
        if (!document.execCommand('delete') || browserSnapshot().draft.trim())
          throw fault('INPUT_FAILED', 'The owned draft could not be cleared.');
        return { cancelled: true };
      }
      const user = s.messages.filter(m => m.role === 'user').at(-1);
      if (user?.id !== b.userId || !user?.text.includes(b.marker)) throw fault('NOT_OWNER', 'Request no longer owns generation.');
      const stop = stopButton();
      if (s.generating && !stop) throw fault('STOP_UNAVAILABLE', 'Response is still rendering but its stop control is unavailable. Retry cancellation after the tab finishes rendering.');
      stop?.click();
      return { cancelled: true };
    }
    if (msg.command !== 'send') throw fault('UNKNOWN_COMMAND', 'Unsupported command.');
    if (msg.args.text.split('\n').length > maxInputLines + 1)
      throw fault('CONTEXT_TOO_LARGE', 'Input exceeds the editor line limit; narrow the source paths. Send was not clicked.');
    if (s.draft.trim() || s.generating) throw fault('DRAFT_PRESENT', 'Composer is occupied.');
    if (!sameBaseline(s.messages.map(m => m.id), b.baseline)) throw fault('CONVERSATION_CHANGED', 'Message baseline changed.');
    if (!b.reasoning) throw fault('REASONING_UNAVAILABLE', 'Verified reasoning is required before sending.');
    checkReasoning(b.reasoning);
    const editor = composer()!;
    editor.focus();
    // A single paragraph with hard breaks avoids insertText creating a paragraph
    // transaction for every source line. textContent escapes all source markup.
    const block = document.createElement('span');
    block.style.whiteSpace = 'pre-wrap';
    block.textContent = normalizeDraft(msg.args.text);
    const html = block.outerHTML.replace(/\n/g, '<br>');
    const range = document.createRange(); range.selectNodeContents(editor);
    const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    if (!document.execCommand('insertHTML', false, html))
      throw fault('INPUT_FAILED', 'Browser rejected text input.');
    await waitForInput(msg.args.text);
    await configureReasoning(undefined, () => {
      checkDeadline();
      const current = browserSnapshot();
      if (normalizeDraft(current.draft) !== normalizeDraft(msg.args.text)) throw fault('INPUT_MISMATCH', 'Owned draft changed before send.');
      if (!current.ordinary || current.url !== b.url || current.generating || !sameBaseline(current.messages.map(m => m.id), b.baseline))
        throw fault('CONVERSATION_CHANGED', 'Target changed before send.');
      checkReasoning(b.reasoning);
    });
    const after = browserSnapshot();
    if (normalizeDraft(after.draft) !== normalizeDraft(msg.args.text)) throw fault('INPUT_MISMATCH', 'Input readback differs; send was not clicked.');
    if (!after.ordinary || after.url !== b.url || after.generating || !sameBaseline(after.messages.map(m => m.id), b.baseline))
      throw fault('CONVERSATION_CHANGED', 'Target changed before send.');
    const button = sendButton();
    if (!button) throw fault('SEND_UNAVAILABLE', 'Send control not available.');
    checkDeadline();
    checkReasoning(b.reasoning);
    button.click();
    return { clicked: true };
  } finally { busy = false; }
}
const listener = (msg: any, _sender: any, reply: any) => {
  execute(msg).then(value => reply({ value }), error => reply({ error: { code: error.code || 'DOM_ERROR', message: error.message } }));
  return true;
};
const world = globalThis as typeof globalThis & { chatMcpListener?: typeof listener };
if (world.chatMcpListener) chrome.runtime.onMessage.removeListener(world.chatMcpListener);
world.chatMcpListener = listener;
chrome.runtime.onMessage.addListener(listener);

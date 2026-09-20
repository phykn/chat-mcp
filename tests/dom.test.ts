import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { hash } from '../src/core/store.js';
import { normalizeDraft } from '../src/core/text.js';

// Entire page is an offline fixture, including its https://chatgpt.com origin.
test('extension DOM path: mode, multiline readback, ownership, draft and completion', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript('window.__name = fn => fn');
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><meta charset="utf-8"><body>
      <button role="radio" aria-checked="true">Chat</button><button role="radio" aria-checked="false">Work</button>
      <div id="prompt-textarea" style="white-space:pre-wrap" contenteditable="true" aria-label="ChatGPT와 채팅"></div>
      <button id="composer-submit-button" aria-label="프롬프트 보내기">Send</button>
      </body></html>` }));
    await page.goto('https://chatgpt.com/');
    await page.evaluate(() => {
      (window as any).chrome = { runtime: { onMessage: { addListener: (fn: any) => { (window as any).handler = fn; } } } };
      (window as any).clicks = 0;
      document.querySelector('button#composer-submit-button')!.addEventListener('click', () => (window as any).clicks++);
    });
    await page.addScriptTag({ content: await readFile('extension/content.js', 'utf8') });
    const call = (msg: any) => page.evaluate(msg => new Promise<any>(resolve => (window as any).handler(msg, {}, resolve)), msg);
    const initial = (await call({ command: 'snapshot' })).value;
    assert.equal(initial.ordinary, true);
    const binding = { url: initial.url, baseline: [], marker: '[marker]' };
    const text = '[marker]\n한국어\n```python\ndef f():\n    return 5\n```';
    assert.deepEqual(await call({ command: 'send', args: { text, binding } }), { value: { clicked: true } });
    assert.equal((await call({ command: 'snapshot' })).value.draft, text);
    assert.equal((await call({ command: 'send', args: { text, binding } })).error.code, 'DRAFT_PRESENT');
    assert.equal(await page.evaluate(() => (window as any).clicks), 1);
    assert.equal((await call({ command: 'cancel', args: { binding } })).error.code, 'NOT_OWNER');
    await page.evaluate(() => { document.querySelectorAll('[role="radio"]')[0].setAttribute('aria-checked', 'false'); document.querySelectorAll('[role="radio"]')[1].setAttribute('aria-checked', 'true'); });
    assert.equal((await call({ command: 'snapshot' })).value.ordinary, false);
    assert.equal((await call({ command: 'send', args: { text, binding } })).error.code, 'CONVERSATION_CHANGED');
    await page.evaluate(() => {
      document.querySelectorAll('[role="radio"]').forEach(e => e.remove());
      document.querySelector('#prompt-textarea')!.setAttribute('aria-label', 'Ask anything');
      const message = document.createElement('div');
      message.setAttribute('data-message-author-role', 'user'); message.setAttribute('data-message-id', 'u1');
      document.body.append(message);
      history.replaceState(null, '', '/c/saved-chat');
    });
    assert.equal((await call({ command: 'snapshot' })).value.ordinary, true, 'saved chats do not depend on localized composer labels');
    await page.evaluate(() => {
      const message = document.createElement('div');
      message.setAttribute('data-message-author-role', 'assistant');
      message.innerHTML = '{"findings":[],"summary":"<a style="display:block" href="https://example.com">https://example.com</a>"}';
      document.body.append(message);
    });
    assert.deepEqual(JSON.parse((await call({ command: 'snapshot' })).value.messages.at(-1).text), { findings: [], summary: 'https://example.com' });
  } finally { await browser.close(); }
});

test('paragraph-based long input preserves blank lines, injects once, and only cancels an unchanged owned draft', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript('window.__name = fn => fn');
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
      <button role="radio" aria-checked="true">Chat</button><button role="radio" aria-checked="false">Work</button>
      <div id="prompt-textarea" contenteditable="true" style="white-space:pre-wrap"><p><br></p></div>
      <button id="composer-submit-button" aria-label="Send prompt" disabled>Send</button></body></html>` }));
    await page.goto('https://chatgpt.com/');
    await page.evaluate(() => {
      const handlers = (window as any).handlers = new Set();
      (window as any).chrome = { runtime: { onMessage: { addListener: (fn: any) => handlers.add(fn), removeListener: (fn: any) => handlers.delete(fn) } } };
      (window as any).clicks = 0;
      document.querySelector('#composer-submit-button')!.addEventListener('click', () => (window as any).clicks++);
      const editor = document.querySelector('#prompt-textarea')!;
      editor.addEventListener('input', () => {
        queueMicrotask(() => { document.querySelector<HTMLButtonElement>('#composer-submit-button')!.disabled = false; });
      });
    });
    const script = await readFile('extension/content.js', 'utf8');
    await page.addScriptTag({ content: script });
    await page.addScriptTag({ content: script });
    assert.equal(await page.evaluate(() => (window as any).handlers.size), 1);
    const call = (msg: any) => page.evaluate(msg => new Promise<any>(resolve => (window as any).handlers.values().next().value(msg, {}, resolve)), msg);
    const text = '[owned-marker]\n' + 'line one\n\n    indented source 한국어\n'.repeat(800) + 'last line';
    const binding = { url: 'https://chatgpt.com/', baseline: [], marker: '[owned-marker]', draftHash: hash(text) };
    assert.deepEqual(await call({ command: 'send', args: { text, binding } }), { value: { clicked: true } });
    assert.equal(normalizeDraft((await call({ command: 'snapshot' })).value.draft), normalizeDraft(text));
    assert.equal(await page.evaluate(() => (window as any).clicks), 1);
    await page.evaluate(() => { document.querySelector('#prompt-textarea')!.append(document.createTextNode(' ')); });
    assert.equal((await call({ command: 'cancel', args: { binding } })).error.code, 'NOT_OWNER', 'even a trailing space edit must be preserved');
    await page.evaluate(() => { document.querySelector('#prompt-textarea')!.lastChild!.remove(); });
    await page.evaluate(() => { document.querySelector('#prompt-textarea')!.append(document.createTextNode('user edit')); });
    assert.equal((await call({ command: 'cancel', args: { binding } })).error.code, 'NOT_OWNER');
    assert.ok((await call({ command: 'snapshot' })).value.draft.includes('user edit'));
    await page.evaluate(() => { document.querySelector('#prompt-textarea')!.lastChild!.remove(); });
    assert.deepEqual(await call({ command: 'cancel', args: { binding } }), { value: { cancelled: true } });
    assert.equal((await call({ command: 'snapshot' })).value.draft.trim(), '');
    assert.equal(await page.evaluate(() => (window as any).clicks), 1);
    await page.evaluate(() => { document.querySelector('#prompt-textarea')!.innerHTML = '<p>alpha</p><p><br></p><p>beta</p>'; });
    assert.equal((await call({ command: 'snapshot' })).value.draft, 'alpha\n\nbeta');
  } finally { await browser.close(); }
});

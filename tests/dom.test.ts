import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { hash } from '../src/core/store.js';
import { normalizeDraft } from '../src/core/text.js';

test('a send expiring while its button renders leaves an owned draft without clicking Send', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript('window.__name = fn => fn');
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
      <button role="radio" aria-checked="true">Chat</button>
      <div id="prompt-textarea" contenteditable="true"></div>
      <button id="composer-submit-button" aria-label="Send prompt" disabled>Send</button>` }));
    await page.goto('https://chatgpt.com/');
    await page.evaluate(() => {
      Date.now = () => 0;
      (window as any).chrome = { runtime: { onMessage: { addListener: (fn: any) => (window as any).handler = fn } } };
      (window as any).clicks = 0;
      document.querySelector('#composer-submit-button')!.addEventListener('click', () => (window as any).clicks++);
    });
    await page.addScriptTag({ content: await readFile('extension/content.js', 'utf8') });
    const pending = page.evaluate(() => new Promise<any>(resolve => (window as any).handler({
      command: 'send', expiresAt: 1,
      args: { text: '[owned] test', binding: { url: location.href, baseline: [], marker: '[owned]' } },
    }, {}, resolve)));
    await page.waitForFunction(() => document.querySelector('#prompt-textarea')!.textContent === '[owned] test');
    await page.evaluate(() => {
      Date.now = () => 2;
      (document.querySelector('#composer-submit-button') as HTMLButtonElement).disabled = false;
    });
    assert.equal((await pending).error?.code, 'COMMAND_EXPIRED');
    assert.equal(await page.evaluate(() => (window as any).clicks), 0);
    assert.equal(await page.locator('#prompt-textarea').innerText(), '[owned] test');
  } finally { await browser.close(); }
});

test('a partially rendered response remains generating without a stop button, and cancellation never clicks Send', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript('window.__name = fn => fn');
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
      <div id="prompt-textarea" contenteditable="true"></div>
      <div data-message-author-role="user" data-message-id="u1">[owned] question</div>
      <div data-turn="assistant"><div data-message-author-role="assistant" data-message-id="a1">
        <div class="streaming-animation">{&quot;ok&quot;:</div>
      </div></div>
      <button id="composer-submit-button" aria-label="Send prompt">Send</button>` }));
    await page.goto('https://chatgpt.com/c/test');
    await page.evaluate(() => {
      (window as any).chrome = { runtime: { onMessage: { addListener: (fn: any) => (window as any).handler = fn } } };
      (window as any).clicks = 0;
      document.querySelector('button')!.onclick = () => (window as any).clicks++;
    });
    await page.addScriptTag({ content: await readFile('extension/content.js', 'utf8') });
    const call = (msg: any) => page.evaluate(msg => new Promise<any>(resolve => (window as any).handler(msg, {}, resolve)), msg);
    const s = (await call({ command: 'snapshot' })).value;
    assert.equal(s.generating, true);
    assert.equal(s.messages.at(-1).complete, false);
    assert.equal((await call({ command: 'cancel', args: { binding: { url: s.url, userId: 'u1', marker: '[owned]' } } })).error.code, 'STOP_UNAVAILABLE');
    assert.equal(await page.evaluate(() => (window as any).clicks), 0);
    await page.evaluate(() => {
      document.querySelector('.streaming-animation')!.className = '';
      document.querySelector('[data-turn="assistant"]')!.insertAdjacentHTML('beforeend', '<button data-testid="copy-turn-action-button">Copy</button>');
    });
    assert.equal((await call({ command: 'snapshot' })).value.generating, false);
    assert.equal((await call({ command: 'snapshot' })).value.messages.at(-1).complete, true);
  } finally { await browser.close(); }
});

test('user changes during the draft ownership check prevent cancellation', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const change of ['typing', 'navigation', 'mode', 'generation', 'messages']) await t.test(change, async () => {
      const page = await browser.newPage();
      await page.addInitScript('window.__name = fn => fn');
      await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
        <button role="radio" aria-checked="true">Chat</button>
        <div id="prompt-textarea" contenteditable="true">[owned] draft</div>
        <button id="composer-submit-button" aria-label="Send prompt">Send</button>` }));
      await page.goto('https://chatgpt.com/');
      await page.evaluate(() => {
        (window as any).chrome = { runtime: { onMessage: { addListener: (fn: any) => (window as any).handler = fn } } };
        const digest = crypto.subtle.digest.bind(crypto.subtle);
        crypto.subtle.digest = async (...args: Parameters<typeof digest>) => {
          (window as any).checking = true;
          await new Promise<void>(resolve => (window as any).resume = resolve);
          return digest(...args);
        };
      });
      await page.addScriptTag({ content: await readFile('extension/content.js', 'utf8') });
      const binding = { url: 'https://chatgpt.com/', baseline: [], marker: '[owned]', draftHash: hash('[owned] draft') };
      const pending = page.evaluate(binding => new Promise<any>(resolve =>
        (window as any).handler({ command: 'cancel', args: { binding } }, {}, resolve)), binding);
      await page.waitForFunction(() => (window as any).checking);
      if (change === 'typing') {
        await page.locator('#prompt-textarea').press('End');
        await page.locator('#prompt-textarea').pressSequentially(' user edit');
      }
      await page.evaluate(change => {
        if (change === 'navigation') history.replaceState(null, '', '/c/another-chat');
        if (change === 'mode') document.querySelector('[role="radio"]')!.setAttribute('aria-checked', 'false');
        if (change === 'generation') document.querySelector('#composer-submit-button')!.setAttribute('aria-label', 'Stop response');
        if (change === 'messages') {
          const user = document.createElement('div');
          user.setAttribute('data-message-author-role', 'user');
          user.setAttribute('data-message-id', 'manual-message');
          document.body.append(user);
        }
        (window as any).resume();
      }, change);
      const result = await pending;
      assert.equal(result.error?.code, 'NOT_OWNER');
      assert.equal(await page.locator('#prompt-textarea').innerText(), '[owned] draft' + (change === 'typing' ? ' user edit' : ''));
      await page.close();
    });
  } finally { await browser.close(); }
});

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

test('paragraph-based long input preserves blank lines, injects once, and only cancels an unchanged owned draft', { timeout: 60_000 }, async () => {
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
    const text = '[owned-marker]\r\n' + 'line one\n\n    indented source 한국어\n'.repeat(350) +
      '<script>window.injected = true</script> & <b>literal</b>\nlast line';
    const binding = { url: 'https://chatgpt.com/', baseline: [], marker: '[owned-marker]', draftHash: hash(normalizeDraft(text)) };
    assert.equal((await call({ command: 'send', args: { text: 'line\n'.repeat(1_202), binding } })).error.code, 'CONTEXT_TOO_LARGE');
    assert.equal((await call({ command: 'snapshot' })).value.draft, '');
    assert.equal(await page.evaluate(() => (window as any).clicks), 0);
    assert.deepEqual(await call({ command: 'send', args: { text, binding } }), { value: { clicked: true } });
    assert.equal(normalizeDraft((await call({ command: 'snapshot' })).value.draft), normalizeDraft(text));
    assert.equal(await page.evaluate(() => (window as any).injected), undefined);
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
    assert.deepEqual(await call({ command: 'cancel', args: { binding } }), { value: { cancelled: true } }, 'retry a cancellation whose reply was lost');
    assert.equal((await call({ command: 'cancel', args: { binding: { ...binding, baseline: ['other'] } } })).error.code, 'NOT_OWNER');
    assert.equal((await call({ command: 'cancel', args: { binding: { ...binding, url: 'https://chatgpt.com/c/other' } } })).error.code, 'CONVERSATION_CHANGED');
    await page.evaluate(() => { document.querySelector('#composer-submit-button')!.setAttribute('aria-label', 'Stop response'); });
    assert.equal((await call({ command: 'cancel', args: { binding } })).error.code, 'NOT_OWNER');
    await page.evaluate(() => { document.querySelector('#composer-submit-button')!.setAttribute('aria-label', 'Send prompt'); });
    await page.evaluate(() => { document.querySelector('#prompt-textarea')!.innerHTML = '<p>alpha</p><p><br></p><p>beta</p>'; });
    assert.equal((await call({ command: 'snapshot' })).value.draft, 'alpha\n\nbeta');
  } finally { await browser.close(); }
});

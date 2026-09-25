import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

test('reasoning selection confirms all safe levels and never selects Pro', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript('window.__name = fn => fn');
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
      <button role="radio" aria-checked="true">Chat</button>
      <div id="prompt-textarea" contenteditable="true"></div>
      <button id="composer-submit-button" aria-label="Send prompt">Send</button>
      <button id="reasoning" data-composer-navigation-target="reasoning" data-selected-reasoning-effort="medium" aria-controls="picker" aria-expanded="false">Reasoning</button>
      <div id="picker" role="menu" data-state="closed">
        <div role="menuitemradio" aria-checked="true">Latest</div>
        <div data-reasoning-slider="true"><span role="slider" aria-valuemin="0" aria-valuemax="4" aria-valuenow="1"></span></div>
      </div>` }));
    await page.goto('https://chatgpt.com/');
    await page.evaluate(() => {
      (window as any).chrome = { runtime: { onMessage: { addListener: (fn: any) => (window as any).handler = fn } } };
      (window as any).clicks = 0;
      (window as any).selected = [];
      document.querySelector('#composer-submit-button')!.addEventListener('click', () => (window as any).clicks++);
      const button = document.querySelector('#reasoning')!;
      button.addEventListener('click', () => {
        const open = button.getAttribute('aria-expanded') !== 'true';
        button.setAttribute('aria-expanded', String(open));
        document.querySelector('#picker')!.setAttribute('data-state', open ? 'open' : 'closed');
      });
      document.querySelector('[data-reasoning-slider]')!.addEventListener('keydown', event => {
        if ((window as any).ignoreKeys) return;
        const slider = document.querySelector('[role="slider"]')!;
        const n = Number(slider.getAttribute('aria-valuenow')) + ((event as KeyboardEvent).key === 'ArrowRight' ? 1 : -1);
        (window as any).selected.push(n);
        slider.setAttribute('aria-valuenow', String(n));
        button.setAttribute('data-selected-reasoning-effort', ['none', 'medium', 'high', 'max', 'ultra'][n]);
      });
    });
    await page.addScriptTag({ content: await readFile('extension/content.js', 'utf8') });
    const call = (command: string, args: any) => page.evaluate(({ command, args }) => new Promise<any>(resolve =>
      (window as any).handler({ command, args }, {}, resolve)), { command, args });
    const binding = { url: 'https://chatgpt.com/', baseline: [], marker: '[owned]' };
    for (const [effort, raw, label] of [['xhigh', 'max', 'Extra High'], ['low', 'none', 'Instant'], ['high', 'high', 'High'], ['medium', 'medium', 'Medium']]) {
      const configured = await call('configure', { binding, reasoning_effort: effort });
      assert.deepEqual(configured.value.reasoning, { effort, raw, label });
      assert.equal(await page.locator('#reasoning').getAttribute('aria-expanded'), 'false');
      assert.deepEqual(await call('send', { text: '[owned] source review', binding: { ...binding, reasoning: configured.value.reasoning } }), { value: { clicked: true } });
      await page.locator('#prompt-textarea').fill('');
    }
    assert.ok((await page.evaluate(() => (window as any).selected)).every((n: number) => n >= 0 && n <= 3));
    assert.equal((await call('configure', { binding })).value.reasoning.effort, 'medium');

    // A claimed safe effort cannot hide a selected Pro model or an unknown UI value.
    for (const name of ['GPT Pro', 'Latest Ultra', 'GPT-5.6 Sol Ultra']) {
      await page.locator('[role="menuitemradio"]').evaluate((el, name) => { el.textContent = name; }, name);
      assert.equal((await call('configure', { binding, reasoning_effort: 'high' })).error.code, 'PRO_FORBIDDEN');
    }
    await page.locator('[role="menuitemradio"]').evaluate(el => { el.textContent = 'Latest Unknown'; });
    assert.equal((await call('configure', { binding })).error.code, 'REASONING_UNAVAILABLE');
    await page.locator('[role="menuitemradio"]').evaluate(el => { el.innerHTML = '<span>GPT-5.6 Sol</span><span>Unknown</span>'; });
    assert.equal((await call('configure', { binding })).error.code, 'REASONING_UNAVAILABLE');
    await page.locator('[role="menuitemradio"]').evaluate(el => { el.innerHTML = '<span>GPT-5.5</span><span>10월 14일 지원 종료</span>'; });
    assert.equal((await call('configure', { binding })).value.reasoning.effort, 'medium');
    await page.locator('[role="menuitemradio"]').evaluate(el => { el.textContent = 'Latest'; });
    await page.locator('#reasoning').evaluate(el => el.setAttribute('data-selected-reasoning-effort', 'ultra'));
    assert.equal((await call('configure', { binding })).error.code, 'PRO_FORBIDDEN');
    await page.locator('#reasoning').evaluate(el => el.setAttribute('data-selected-reasoning-effort', 'new-level'));
    assert.equal((await call('configure', { binding })).error.code, 'REASONING_UNAVAILABLE');
    assert.equal(await page.evaluate(() => (window as any).clicks), 4);

    await page.locator('#reasoning').evaluate(el => el.setAttribute('data-selected-reasoning-effort', 'medium'));
    const setting = (await call('configure', { binding })).value.reasoning;
    await page.locator('#reasoning').evaluate(el => el.setAttribute('data-selected-reasoning-effort', 'high'));
    assert.equal((await call('send', { text: '[owned] source', binding: { ...binding, reasoning: setting } })).error.code, 'REASONING_MISMATCH');
    assert.equal((await page.locator('#prompt-textarea').innerText()).trim(), '');

    await page.locator('#reasoning').evaluate(el => el.setAttribute('data-selected-reasoning-effort', 'medium'));
    await page.locator('[role="menuitemradio"]').evaluate(el => { el.textContent = 'GPT Pro'; });
    assert.equal((await call('send', { text: '[owned] source', binding: { ...binding, reasoning: setting } })).error.code, 'PRO_FORBIDDEN');
    assert.equal(await page.evaluate(() => (window as any).clicks), 4);
    await page.locator('[role="menuitemradio"]').evaluate(el => { el.textContent = 'Latest'; });
    await page.locator('#prompt-textarea').fill('');

    // React/editor work can change settings while input is being accepted.
    await page.locator('#reasoning').evaluate(el => el.setAttribute('data-selected-reasoning-effort', 'medium'));
    await page.evaluate(() => document.querySelector('#prompt-textarea')!.addEventListener('input', () =>
      document.querySelector('#reasoning')!.setAttribute('data-selected-reasoning-effort', 'ultra'), { once: true }));
    assert.equal((await call('send', { text: '[owned] source', binding: { ...binding, reasoning: setting } })).error.code, 'PRO_FORBIDDEN');
    assert.equal(await page.evaluate(() => (window as any).clicks), 4);
    await page.locator('#prompt-textarea').fill('');
    await page.locator('#reasoning').evaluate(el => el.setAttribute('data-selected-reasoning-effort', 'medium'));
    await page.evaluate(() => {
      const button = document.querySelector('#reasoning')!;
      button.remove();
      setTimeout(() => document.body.append(button), 150);
    });
    assert.equal((await call('configure', { binding })).value.reasoning.effort, 'medium', 'waits for a late-mounted model control');
    await page.evaluate(() => { (window as any).ignoreKeys = true; });
    assert.equal((await call('configure', { binding, reasoning_effort: 'high' })).error.code, 'REASONING_UNAVAILABLE');
    assert.equal(await page.evaluate(() => (window as any).clicks), 4);
  } finally { await browser.close(); }
});

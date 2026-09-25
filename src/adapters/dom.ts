import type { Snapshot } from '../core/types.js';
import { readReasoning } from './reasoning.js';

// innerText adds layout-dependent blank lines between ProseMirror paragraphs.
// Read the editor's text structure so source whitespace survives round trips.
export function composerText(editor: HTMLElement): string {
  if (editor instanceof HTMLTextAreaElement) return editor.value;
  const read = (parent: Node): string => {
    let text = '', previousBlock = false;
    for (const node of parent.childNodes) {
      const element = node instanceof HTMLElement ? node : undefined;
      const block = !!element && /^(P|DIV|PRE)$/.test(element.tagName);
      if (text && (block || previousBlock)) text += '\n';
      else if (previousBlock) text += '\n';
      if (element?.tagName === 'BR') {
        if (node.nextSibling) text += '\n';
      } else text += element ? read(element) : node.textContent || '';
      previousBlock = block;
    }
    return text;
  };
  return read(editor);
}

export function stopButton() {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label]')]
    .filter(button => /^(답변 중지|응답 중지|Stop response|중지|Stop)$/.test(button.getAttribute('aria-label') || ''));
  return buttons.length === 1 ? buttons[0] : undefined;
}

export function composer() {
  return document.querySelector<HTMLElement>('#prompt-textarea, [data-composer-markdown][contenteditable="true"][role="textbox"]');
}

export function sendButton() {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('#composer-submit-button, button[type="submit"]')]
    .filter(button => !button.disabled && /^(프롬프트 보내기|Send prompt|보내기|Send)$/.test(button.getAttribute('aria-label') || ''));
  return buttons.length === 1 ? buttons[0] : undefined;
}

// Runs only in the connected ChatGPT page. Selectors observed on 2026-09-25.
export function browserSnapshot(): Snapshot {
  const editor = composer();
  const modes = [...document.querySelectorAll('[role="radio"], button[aria-pressed]')];
  const chat = modes.find(e => e.textContent?.trim() === 'Chat');
  const work = modes.find(e => e.textContent?.trim() === 'Work');
  const messageText = (e: HTMLElement) => {
    // Layout adds line breaks around links inside otherwise valid JSON responses.
    for (const candidate of [...e.querySelectorAll('pre code')].map(code => code.textContent || '').concat(e.textContent || '')) {
      if (!candidate.trim().startsWith('{')) continue;
      try { JSON.parse(candidate); return candidate; } catch { /* Keep ordinary prose formatting below. */ }
    }
    return e.innerText;
  };
  const legacy = [...document.querySelectorAll<HTMLElement>('[data-message-author-role]')];
  const current = [...document.querySelectorAll<HTMLElement>('[data-chatgpt-search-unit-key]')]
    .filter(e => /:(user|assistant)$/.test(e.getAttribute('data-chatgpt-search-unit-key') || ''));
  const messages = legacy.length ? legacy.map(e => ({
    id: e.getAttribute('data-message-id') || '', role: e.getAttribute('data-message-author-role') || '',
    text: messageText(e),
    complete: !!e.closest('[data-turn="assistant"]')?.querySelector('[data-testid="copy-turn-action-button"]'),
  })) : current.map(e => {
    const role = e.getAttribute('data-chatgpt-search-unit-key')!.split(':').at(-1)!;
    const body = e.querySelector<HTMLElement>(role === 'user' ? '[data-user-message-bubble]' : '[data-markdown-text-style="assistant-message"]');
    const turn = e.closest('[data-content-search-turn-key]');
    const last = [...(turn?.querySelectorAll('[data-chatgpt-search-unit-key$=":assistant"]') || [])].at(-1);
    return { id: (e.getAttribute('data-chatgpt-search-message-ids') || '').split(/\s+/)[0], role,
      text: body ? messageText(body) : '',
      complete: role === 'assistant' && e === last && !!turn?.querySelector('button[aria-label="응답 다시 생성"], button[aria-label="Regenerate response"]') };
  });
  const lastAssistant = legacy.length ? [...document.querySelectorAll('[data-message-author-role="assistant"]')].at(-1)
    : current.filter(e => e.getAttribute('data-chatgpt-search-unit-key')?.endsWith(':assistant')).at(-1);
  const streaming = !!lastAssistant?.querySelector('.streaming-animation');
  const selectedChat = chat?.getAttribute('aria-checked') === 'true' || chat?.getAttribute('aria-pressed') === 'true';
  const selectedWork = work?.getAttribute('aria-checked') === 'true' || work?.getAttribute('aria-pressed') === 'true';
  const chatThread = /^\/c\/[^/]+$/.test(location.pathname) && messages.some(m => m.role === 'user');
  return { url: location.href, draft: editor ? composerText(editor) : '', reasoning: readReasoning(),
    ordinary: location.origin === 'https://chatgpt.com' && !!editor && !selectedWork && (selectedChat || chatThread),
    visible: document.visibilityState === 'visible',
    canStop: !!stopButton(),
    generating: !!stopButton() || (streaming && !messages.filter(m => m.role === 'assistant').at(-1)?.complete), messages,
    error: [...document.querySelectorAll('[role="alert"]')].map(e => e.textContent || '').filter(Boolean).join('\n') || undefined };
}

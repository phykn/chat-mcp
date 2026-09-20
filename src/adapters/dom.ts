import type { Snapshot } from '../core/types.js';

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

// Runs only in the connected ChatGPT page. Selectors observed on 2026-09-20.
export function browserSnapshot(): Snapshot {
  const editor = document.querySelector<HTMLElement>('#prompt-textarea');
  const radios = [...document.querySelectorAll('[role="radio"]')];
  const chat = radios.find(e => e.textContent?.trim() === 'Chat');
  const work = radios.find(e => e.textContent?.trim() === 'Work');
  const messageText = (e: HTMLElement) => {
    // Layout adds line breaks around links inside otherwise valid JSON responses.
    for (const candidate of [...e.querySelectorAll('pre code')].map(code => code.textContent || '').concat(e.textContent || '')) {
      if (!candidate.trim().startsWith('{')) continue;
      try { JSON.parse(candidate); return candidate; } catch { /* Keep ordinary prose formatting below. */ }
    }
    return e.innerText;
  };
  const messages = [...document.querySelectorAll<HTMLElement>('[data-message-author-role]')].map(e => ({
    id: e.getAttribute('data-message-id') || '', role: e.getAttribute('data-message-author-role') || '',
    text: messageText(e),
    complete: !!e.closest('[data-turn="assistant"]')?.querySelector('[data-testid="copy-turn-action-button"]'),
  }));
  const label = document.querySelector('#composer-submit-button')?.getAttribute('aria-label') || '';
  const selectedChat = chat?.getAttribute('aria-checked') === 'true';
  const selectedWork = work?.getAttribute('aria-checked') === 'true';
  const chatThread = /^\/c\/[^/]+$/.test(location.pathname) && messages.some(m => m.role === 'user');
  return { url: location.href, draft: editor ? composerText(editor) : '',
    ordinary: location.origin === 'https://chatgpt.com' && !!editor && !selectedWork && (selectedChat || chatThread),
    generating: /답변 중지|Stop response/.test(label), messages,
    error: [...document.querySelectorAll('[role="alert"]')].map(e => e.textContent || '').filter(Boolean).join('\n') || undefined };
}

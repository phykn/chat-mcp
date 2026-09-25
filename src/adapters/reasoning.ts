import { Fault, type ReasoningEffort, type ReasoningSetting } from '../core/types.js';

const levels = [
  { effort: 'low', raw: 'none', label: 'Instant' },
  { effort: 'medium', raw: 'medium', label: 'Medium' },
  { effort: 'high', raw: 'high', label: 'High' },
  { effort: 'xhigh', raw: 'max', label: 'Extra High' },
] as const;

export function reasoningButton() {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('button[data-selected-reasoning-effort][data-composer-navigation-target="reasoning"]')];
  return buttons.length === 1 ? buttons[0] : undefined;
}

export function readReasoning(): ReasoningSetting | undefined {
  const button = reasoningButton();
  if (!button) return undefined;
  const raw = button.getAttribute('data-selected-reasoning-effort') || '';
  const level = levels.find(level => level.raw === raw);
  return level ? { ...level } : { raw, label: raw };
}

export function checkReasoning(expected?: ReasoningSetting) {
  const current = readReasoning();
  if (/\bpro\b|프로|ultra/i.test(`${current?.raw || ''} ${reasoningButton()?.textContent || ''}`))
    throw new Fault('PRO_FORBIDDEN', 'Pro is never allowed. Select a non-Pro reasoning level before retrying.');
  if (!current?.effort) throw new Fault('REASONING_UNAVAILABLE', 'Cannot verify a supported non-Pro reasoning level; send was not clicked.');
  if (expected && (current.raw !== expected.raw || current.effort !== expected.effort))
    throw new Fault('REASONING_MISMATCH', 'Reasoning changed after configuration; send was not clicked.');
  return current;
}

export async function configureReasoning(effort: ReasoningEffort | undefined, check: () => void) {
  check();
  const wait = async (ready: () => boolean, timeout = 2_000) => {
    const until = Date.now() + timeout;
    while (!ready()) {
      check();
      if (Date.now() >= until) throw new Fault('REASONING_UNAVAILABLE', 'Reasoning control did not confirm the requested state; send was not clicked.');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    check();
  };
  // New-chat navigation can mount the composer before the model control.
  await wait(() => !!readReasoning()?.raw, 5_000);
  const before = checkReasoning();
  const button = reasoningButton()!;
  const menu = () => {
    const id = button.getAttribute('aria-controls');
    const element = id ? document.getElementById(id) : undefined;
    return element?.getAttribute('role') === 'menu' && element.getAttribute('data-state') === 'open' ? element : undefined;
  };
  const opened = button.getAttribute('aria-expanded') !== 'true';
  if (opened) button.click();
  try {
    await wait(() => !!menu());
    const verifyModel = () => {
      check();
      const selected = menu()?.querySelectorAll('[role="menuitemradio"][aria-checked="true"]');
      if (selected?.length !== 1) throw new Fault('REASONING_UNAVAILABLE', 'Selected model cannot be verified; send was not clicked.');
      const name = selected[0].textContent?.trim() || '';
      if (/\bpro\b|프로|\bultra\b/i.test(name)) throw new Fault('PRO_FORBIDDEN', 'Pro models are never allowed.');
      // Only the observed non-Pro model entries are supported. Unknown UI must fail closed.
      const label = selected[0].querySelector('span')?.textContent?.trim() || name;
      const detail = name.slice(label.length).trim();
      const retirement = label === 'GPT-5.5' && /^\d{1,2}월 \d{1,2}일 지원 종료$/.test(detail);
      if (!['최신', 'Latest', 'GPT-5.6 Sol', 'GPT-5.5'].includes(label) || !name.startsWith(label) || (detail && !retirement))
        throw new Fault('REASONING_UNAVAILABLE', 'Selected model is not a verified non-Pro model.');
    };
    verifyModel();
    const target = levels.findIndex(level => level.effort === (effort || before.effort));
    for (let steps = 0; steps < levels.length; steps++) {
      verifyModel();
      const current = checkReasoning();
      const index = levels.findIndex(level => level.raw === current.raw);
      if (index === target) return current;
      const control = menu()?.querySelector<HTMLElement>('[data-reasoning-slider="true"]');
      const slider = control?.querySelector('[role="slider"]');
      if (!control || slider?.getAttribute('aria-valuemin') !== '0' || slider.getAttribute('aria-valuemax') !== '4' ||
          slider.getAttribute('aria-valuenow') !== String(index))
        throw new Fault('REASONING_UNAVAILABLE', 'Unsupported reasoning slider; send was not clicked.');
      const next = index + (target > index ? 1 : -1);
      // There is deliberately no path to the fifth (Pro/Ultra) position.
      if (next < 0 || next >= levels.length) throw new Fault('PRO_FORBIDDEN', 'Requested reasoning is outside the non-Pro range.');
      check();
      const key = next > index ? 'ArrowRight' : 'ArrowLeft';
      control.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
      await wait(() => readReasoning()?.raw === levels[next].raw);
    }
    throw new Fault('REASONING_MISMATCH', 'Requested reasoning was not applied.');
  } finally {
    if (opened && button.isConnected && button.getAttribute('aria-expanded') === 'true') button.click();
  }
}

import type { ReasoningSetting } from './types.js';

export const reasoningLevels = [
  { effort: 'low', raw: 'none', label: 'Instant' },
  { effort: 'medium', raw: 'medium', label: 'Medium' },
  { effort: 'high', raw: 'high', label: 'High' },
  { effort: 'xhigh', raw: 'max', label: 'Extra High' },
] as const;

export function verifiedReasoning(setting?: ReasoningSetting) {
  return reasoningLevels.find(level => level.raw === setting?.raw && level.effort === setting?.effort)?.effort;
}

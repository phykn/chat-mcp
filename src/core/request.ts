import type { ReasoningSetting, Record } from './types.js';

const draftErrors = ['INPUT_MISMATCH', 'INPUT_FAILED', 'SEND_UNAVAILABLE', 'CONVERSATION_CHANGED', 'COMMAND_EXPIRED',
  'REASONING_UNAVAILABLE', 'REASONING_MISMATCH', 'PRO_FORBIDDEN'];

const effortByRaw = { none: 'low', medium: 'medium', high: 'high', max: 'xhigh' } as const;
export function verifiedReasoning(setting?: ReasoningSetting) {
  if (!setting) return undefined;
  const effort = effortByRaw[setting.raw as keyof typeof effortByRaw];
  return effort && setting.effort === effort ? effort : undefined;
}

export function isTemporaryChat(path: string) {
  return /^\/c\/(?:WEB:|local-chatgpt(?::|%3a))/i.test(path);
}

export function isConnectionError(code: string) {
  return ['BRIDGE_TIMEOUT', 'BRIDGE_UNAVAILABLE', 'EXTENSION_DISCONNECTED', 'CONTENT_UNAVAILABLE', 'COMMAND_EXPIRED'].includes(code);
}

export function isSendRejected(code: string) {
  return code === 'DRAFT_PRESENT' || code === 'CONTEXT_TOO_LARGE' || draftErrors.includes(code);
}

export function isTerminal(r: Record) {
  return ['completed', 'cancelled', 'failed'].includes(r.status);
}

export function isPending(r: Record) {
  return ['sending', 'sent', 'unknown_commit', 'timed_out_after_send'].includes(r.status);
}

export function isUnresolved(r: Record) {
  return r.status === 'prepared' || isPending(r);
}

export function isCancellable(r: Record) {
  return isUnresolved(r) || (r.status === 'failed' && !!r.binding?.draftHash &&
    draftErrors.includes(r.error?.code || ''));
}

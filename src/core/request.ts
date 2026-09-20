import type { Record } from './types.js';

const draftErrors = ['INPUT_MISMATCH', 'INPUT_FAILED', 'SEND_UNAVAILABLE', 'CONVERSATION_CHANGED'];

export function isSendRejected(code: string) {
  return code === 'DRAFT_PRESENT' || draftErrors.includes(code);
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

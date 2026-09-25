import { z } from 'zod';
import type { Record } from './core/types.js';
import { isPending, isCancellable } from './core/request.js';

const reviewSchema = z.object({
  findings: z.array(z.object({
    severity: z.enum(['P0', 'P1', 'P2', 'P3']), file: z.string(), line: z.number().int().positive(),
    evidence: z.string(), fix: z.string(),
  })),
  summary: z.string(),
});

export function result(value: unknown, isError = false) {
  if (value && typeof value === 'object' && 'id' in value) value = formatRecord(value as Record);
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError };
}

function formatRecord(record: Record) {
  const value = {
    request_id: record.id, conversation_handle: record.handle, status: record.status,
    answer: record.answer, review_scope: record.material?.scope, files: record.material?.files,
    omitted: record.material?.omitted, elapsed_ms: record.elapsed_ms, error: record.error,
    requested_reasoning_effort: record.requested_reasoning_effort,
    applied_reasoning: record.applied_reasoning,
    active: record.active,
    worker_active: record.active ?? false,
    send_state: record.send_state ?? (record.binding?.userId || record.status === 'completed' ? 'confirmed'
      : isPending(record) || record.status === 'cancelled' && record.binding?.draftHash ? 'unknown' : 'not_sent'),
    answer_complete: record.status === 'completed',
    answer_state: record.status === 'completed' ? 'complete' : record.answer ? 'partial' : 'unavailable',
    last_observation: record.observation,
    cancel_requested: record.cancel_requested ?? false,
    conversation_reusable: record.status === 'completed',
    next_action: record.status === 'completed' ? 'Use conversation_handle for a follow-up with a new request_id.'
      : record.active ? 'Wait for the active worker; do not resend.'
      : isPending(record) ? 'Call chatgpt_result with this request_id to recover, or chatgpt_cancel. Do not resend with a new ID.'
      : isCancellable(record) ? 'Call chatgpt_cancel with this request_id to clear its owned draft before starting a new request.'
      : 'Start a new request with a new request_id and omit conversation_handle. This answer is not a completed review.',
    review: undefined as z.infer<typeof reviewSchema> | undefined,
    warning: undefined as string | undefined,
  };
  if (record.status === 'completed' && record.material?.scope !== 'ask' && record.answer) {
    try {
      const parsed = JSON.parse(record.answer.replace(/^```(?:json)?\s*|\s*```$/g, ''));
      value.review = reviewSchema.parse(parsed);
      // Keep the raw answer on disk, but do not send the same review to Codex twice.
      value.answer = undefined;
    } catch {
      value.warning = 'Review schema not satisfied; raw answer retained. No regeneration was requested.';
    }
  }
  return value;
}

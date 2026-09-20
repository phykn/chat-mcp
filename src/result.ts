import { z } from 'zod';
import type { Record } from './core/types.js';

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

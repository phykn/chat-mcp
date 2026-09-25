export class Fault extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); }
}
export type Status = 'prepared' | 'sending' | 'sent' | 'completed' | 'unknown_commit' |
  'timed_out_after_send' | 'cancelled' | 'failed';
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export interface ReasoningSetting { effort?: ReasoningEffort; raw: string; label: string; }
export interface Snapshot {
  url: string;
  ordinary: boolean;
  draft: string;
  generating: boolean;
  visible?: boolean;
  canStop?: boolean;
  messages: { id: string; role: string; text: string; complete: boolean }[];
  error?: string;
  reasoning?: ReasoningSetting;
}
export interface Binding {
  url: string;
  baseline: string[];
  marker: string;
  draftHash?: string;
  userId?: string;
  reasoning?: ReasoningSetting;
}
export interface Adapter {
  snapshot(binding?: Binding, deadline?: number): Promise<Snapshot>;
  prepare(handle?: string, deadline?: number): Promise<Snapshot>;
  configure(binding: Binding, effort?: ReasoningEffort, deadline?: number): Promise<Snapshot>;
  send(text: string, binding: Binding, deadline?: number): Promise<void>;
  cancel(binding: Binding): Promise<void>;
}
export interface Material {
  prompt: string;
  scope: string;
  files: string[];
  omitted: { path: string; reason: string }[];
}
export interface Record {
  id: string; hash: string; status: Status; started: number; updated: number;
  handle: string; binding?: Binding; material?: Omit<Material, 'prompt'>;
  answer?: string; error?: { code: string; message: string; details?: unknown }; elapsed_ms?: number;
  active?: boolean;
  answer_complete?: boolean;
  observation?: { at: number; generating: boolean; visible: boolean | null; answer_complete: boolean };
  cancel_requested?: boolean;
  send_state?: 'not_sent' | 'unknown' | 'confirmed';
  requested_reasoning_effort?: ReasoningEffort;
  applied_reasoning?: ReasoningSetting;
}

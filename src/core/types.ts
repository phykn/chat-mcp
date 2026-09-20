export class Fault extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); }
}
export type Status = 'prepared' | 'sending' | 'sent' | 'completed' | 'unknown_commit' |
  'timed_out_after_send' | 'cancelled' | 'failed';
export interface Snapshot {
  url: string;
  ordinary: boolean;
  draft: string;
  generating: boolean;
  visible?: boolean;
  messages: { id: string; role: string; text: string; complete: boolean }[];
  error?: string;
}
export interface Binding {
  url: string;
  baseline: string[];
  marker: string;
  draftHash?: string;
  userId?: string;
}
export interface Adapter {
  snapshot(binding?: Binding): Promise<Snapshot>;
  prepare(handle?: string): Promise<Snapshot>;
  send(text: string, binding: Binding): Promise<void>;
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
  answer?: string; error?: { code: string; message: string }; elapsed_ms?: number;
}

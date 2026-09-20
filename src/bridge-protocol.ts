import { z } from 'zod';
import type { Snapshot } from './core/types.js';

export const bridgePort = 9234;
export const bridgeProtocol = 2;
export const commandTimeout = 15_000;
export const bridgeUrl = (port = bridgePort) => `http://127.0.0.1:${port}`;

const binding = z.object({
  url: z.string(), baseline: z.array(z.string()), marker: z.string(), userId: z.string().optional(), draftHash: z.string().optional(),
});
export const commandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('snapshot'), args: z.object({ binding }).optional() }),
  z.object({ command: z.literal('new'), args: z.object({ expectedUrl: z.string() }) }),
  z.object({ command: z.literal('send'), args: z.object({ text: z.string(), binding }) }),
  z.object({ command: z.literal('cancel'), args: z.object({ binding }) }),
]);
export type Command = z.infer<typeof commandSchema>;
export interface CommandResults {
  snapshot: Snapshot;
  new: { navigating: boolean };
  send: { clicked: boolean };
  cancel: { cancelled: boolean };
}
export type Reply<T = unknown> = { value: T; error?: never } | {
  error: { code: string; message: string }; value?: never;
};
export function failure(code: string, message: string): Reply<never> {
  return { error: { code, message } };
}

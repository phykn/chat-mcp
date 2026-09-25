import { z } from 'zod';
import type { Snapshot } from './core/types.js';

export const bridgePort = 9234;
export const bridgeProtocol = 4;
export const commandTimeout = 15_000;
export const bridgeUrl = (port = bridgePort) => `http://127.0.0.1:${port}`;

const binding = z.object({
  url: z.string(), baseline: z.array(z.string()), marker: z.string(), userId: z.string().optional(), draftHash: z.string().optional(),
  reasoning: z.object({ effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(), raw: z.string(), label: z.string() }).optional(),
});
const reasoningEffort = z.enum(['low', 'medium', 'high', 'xhigh']);
const deadline = z.number().finite().optional();
export const commandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('snapshot'), args: z.object({ binding }).optional(), deadline }),
  z.object({ command: z.literal('new'), args: z.object({ expectedUrl: z.string() }), deadline }),
  z.object({ command: z.literal('configure'), args: z.object({ binding, reasoning_effort: reasoningEffort.optional() }), deadline }),
  z.object({ command: z.literal('send'), args: z.object({ text: z.string(), binding }), deadline }),
  z.object({ command: z.literal('cancel'), args: z.object({ binding }), deadline }),
]);
export type Command = z.infer<typeof commandSchema>;
// Large plain-text inputs can keep ChatGPT's editor busy beyond the normal RPC window.
export const commandTimeoutFor = (command: Command) => command.command === 'send' ? 60_000 : commandTimeout;
export interface CommandResults {
  snapshot: Snapshot;
  new: { navigating: boolean };
  configure: Snapshot;
  send: { clicked: boolean };
  cancel: { cancelled: boolean };
}
export type Reply<T = unknown> = { value: T; error?: never } | {
  error: { code: string; message: string }; value?: never;
};
export function failure(code: string, message: string): Reply<never> {
  return { error: { code, message } };
}

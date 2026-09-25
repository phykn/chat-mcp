import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { dataDir } from './config.js';
import { Store } from './core/store.js';
import { Orchestrator } from './core/orchestrator.js';
import { ExtensionAdapter } from './adapters/extension.js';
import { collectAsk, collectReview, contextMetadata } from './context/collect.js';
import { Fault } from './core/types.js';
import { join } from 'node:path';
import { instructions } from './instructions.js';
import { health } from './health.js';
import { result } from './result.js';

const adapter = new ExtensionAdapter();
const store = new Store(join(dataDir, 'requests'));
const runner = new Orchestrator(store, adapter);
const server = new McpServer({ name: 'chat-mcp', version: '0.1.0' }, { instructions });
const nonblank = z.string().min(1).refine(value => value.trim().length > 0, 'Must not be blank.');
const id = nonblank.max(200);
const paths = z.array(z.string().min(1)).max(100).optional();
const reasoningEffort = z.enum(['low', 'medium', 'high', 'xhigh']).optional();
async function guard(fn: () => Promise<unknown>) {
  try { return result(await fn()); }
  catch (e) { const f = e instanceof Fault ? e : new Fault('INTERNAL_ERROR', String(e)); return result({ error: f.code, message: f.message, details: f.details }, true); }
}
server.registerTool('chatgpt_ask', {
  description: 'Delegate design comparisons, difficult debugging, or lengthy analysis to ChatGPT. Pass file paths for local context collection. Call once and wait; retry uncertain outcomes with the same request_id and identical inputs.',
  inputSchema: { request_id: id, prompt: nonblank.max(48_000), repo_path: z.string().optional(), context_paths: paths, conversation_handle: nonblank.optional(), reasoning_effort: reasoningEffort },
}, input => guard(() => runner.run(input, () => collectAsk(input))));
server.registerTool('review_with_chatgpt', {
  description: 'Review code structure, readability, or changes directly from repo_path. With working_tree, supplied file or folder paths include unchanged code and available diffs; a clean repository can also be reviewed. Without paths, prefer changed files when present. staged and branch review changes only. No need to paste code. Return actionable findings.',
  inputSchema: { request_id: id, repo_path: z.string(), scope: z.enum(['working_tree', 'staged', 'branch']), base_ref: z.string().optional(), paths, question: z.string().max(8_000).optional(), reasoning_effort: reasoningEffort },
}, input => guard(() => runner.run(input, () => collectReview(input))));
server.registerTool('chatgpt_preview', {
  description: 'Inspect context bytes, lines, limits, included files and omissions before sending. No browser access, request record, or message is created. Preview is not a reservation; send recollects current files.',
  inputSchema: { mode: z.enum(['ask', 'review']), prompt: nonblank.max(48_000).optional(), repo_path: z.string().optional(),
    context_paths: paths, scope: z.enum(['working_tree', 'staged', 'branch']).optional(), base_ref: z.string().optional(),
    paths, question: z.string().max(8_000).optional() },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, input => guard(async () => {
  if (input.mode === 'ask') {
    if (!input.prompt) throw new Fault('PROMPT_REQUIRED', 'Ask preview requires prompt.');
    return contextMetadata(await collectAsk({ ...input, prompt: input.prompt }, { preview: true }));
  }
  if (!input.repo_path || !input.scope) throw new Fault('REVIEW_SCOPE_REQUIRED', 'Review preview requires repo_path and scope.');
  return contextMetadata(await collectReview({ ...input, repo_path: input.repo_path, scope: input.scope }, { preview: true }));
}));
server.registerTool('chatgpt_health', { description: 'Check once before the first request. Returns ready and a next_action for setup, connection, or recovery; no chat content is exposed.',
  inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false } }, () => guard(() => health(store, adapter)));
server.registerTool('chatgpt_cancel', { description: 'Cancel this request’s owned generation or clear its unchanged unsent draft. Returns cancel_requested while its worker handles cancellation.', inputSchema: { request_id: id } }, ({ request_id }) => guard(() => runner.cancel(request_id)));
server.registerTool('chatgpt_result', { description: 'Retrieve a request by ID without original inputs or resending. Returns immediately for completed or actively running requests; otherwise recovers the existing response for up to 30 seconds. Keep the managed chat open.', inputSchema: { request_id: id } }, ({ request_id }) => guard(() => runner.retrieve(request_id)));
await server.connect(new StdioServerTransport());
process.stdin.on('end', () => process.exit(0));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { dataDir } from './config.js';
import { Store } from './core/store.js';
import { Orchestrator } from './core/orchestrator.js';
import { ExtensionAdapter } from './adapters/extension.js';
import { collectAsk, collectReview } from './context/collect.js';
import { Fault } from './core/types.js';
import { join } from 'node:path';
import { instructions } from './instructions.js';
import { health } from './health.js';
import { result } from './result.js';

const adapter = new ExtensionAdapter();
const store = new Store(join(dataDir, 'requests'));
const runner = new Orchestrator(store, adapter);
const server = new McpServer({ name: 'chat-mcp', version: '0.1.0' }, { instructions });
const id = z.string().min(1).max(200);
const paths = z.array(z.string().min(1)).max(100).optional();
async function guard(fn: () => Promise<unknown>) {
  try { return result(await fn()); }
  catch (e) { const f = e instanceof Fault ? e : new Fault('INTERNAL_ERROR', String(e)); return result({ error: f.code, message: f.message, details: f.details }, true); }
}
server.registerTool('chatgpt_ask', {
  description: 'Delegate design comparisons, difficult debugging, or lengthy analysis to ChatGPT. Pass file paths for local context collection. Call once and wait; retry uncertain outcomes with the same request_id and identical inputs.',
  inputSchema: { request_id: id, prompt: z.string().min(1).max(48_000), repo_path: z.string().optional(), context_paths: paths, conversation_handle: z.string().optional() },
}, input => guard(() => runner.run(input, () => collectAsk(input))));
server.registerTool('review_with_chatgpt', {
  description: 'Use first for substantial code reviews and once after non-trivial implementation. Collect the diff and matching file contents directly from repo_path; no need to paste code. Narrow paths for focused reviews. Return actionable findings.',
  inputSchema: { request_id: id, repo_path: z.string(), scope: z.enum(['working_tree', 'staged', 'branch']), base_ref: z.string().optional(), paths, question: z.string().max(8_000).optional() },
}, input => guard(() => runner.run(input, () => collectReview(input))));
server.registerTool('chatgpt_health', { description: 'Check once before the first request. Returns ready and a next_action for setup, connection, or recovery; no chat content is exposed.',
  inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false } }, () => guard(() => health(store, adapter)));
server.registerTool('chatgpt_cancel', { description: 'Cancel this request’s owned generation or clear its unchanged unsent draft. Returns cancel_requested while its worker handles cancellation.', inputSchema: { request_id: id } }, ({ request_id }) => guard(() => runner.cancel(request_id)));
await server.connect(new StdioServerTransport());
process.stdin.on('end', () => process.exit(0));

import { join } from 'node:path';
import { dataDir } from './config.js';
import { Fault, type Adapter } from './core/types.js';
import type { Store } from './core/store.js';
import { isUnresolved } from './core/request.js';
import { verifiedReasoning } from './core/request.js';

export async function health(store: Store, adapter: Adapter) {
  const records = (await store.records()).sort((a, b) => b.updated - a.updated);
  const pending = records.filter(isUnresolved);
  const recent = [...pending, ...records.filter(r => !pending.includes(r)).slice(0, 5)];
  const requests = recent.map(r => ({ request_id: r.id, status: r.status, conversation_handle: r.handle,
    requested_reasoning_effort: r.requested_reasoning_effort, applied_reasoning: r.applied_reasoning, error: r.error }));
  const owner = await store.lockInfo();
  const operation = owner ? { active: owner.active, request_id: owner.request_id, started: owner.started } : undefined;
  try {
    const s = await adapter.snapshot();
    const next = !s.ordinary ? 'Open ChatGPT, sign in, and select Chat in the connected tab.'
      : !verifiedReasoning(s.reasoning) ? 'Select a supported reasoning level (Instant, Thinking Medium, High, or Extra High); Pro is unavailable.'
      : operation?.active ? 'A request is active. Use chatgpt_result with its request_id for status; do not start another request.'
      : pending.length ? 'Use chatgpt_result with the outstanding request_id to recover it, or chatgpt_cancel to stop it.'
      : s.generating ? 'Wait for the current ChatGPT answer to finish.'
      : s.draft.trim() ? 'Send or clear the draft in the connected ChatGPT tab.' : undefined;
    return { browser: 'connected', ready: !next, ordinary_chat: s.ordinary, reasoning: s.reasoning, generating: s.generating,
      draft_present: !!s.draft.trim(), next_action: next, operation, requests };
  } catch (e) {
    const code = e instanceof Fault ? e.code : 'INTERNAL_ERROR';
    const next = code === 'EXTENSION_DISCONNECTED'
      ? 'Click Open ChatGPT in the Chat MCP extension to reconnect. If missing, load extension_folder in chrome://extensions; it connects automatically.'
      : code === 'CONTENT_UNAVAILABLE' ? 'Wait for the ChatGPT tab to finish loading and check again. If this persists, reload the extension in chrome://extensions.'
      : code === 'SETUP_REQUIRED' ? 'Run npm run setup from the project folder, then reconnect the Chrome extension.'
      : code === 'BRIDGE_CONFLICT' ? 'Another Chat MCP installation is using port 9234. Stop that bridge before retrying.'
      : code === 'BRIDGE_VERSION' ? 'Stop the old Chat MCP bridge process and retry to start the updated bridge.'
      : 'Run npm run setup from the project folder and check the connection again.';
    return { browser: 'unavailable', ready: false, error: code, next_action: next,
      extension_folder: join(dataDir, 'extension'), operation, requests };
  }
}

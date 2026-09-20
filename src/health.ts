import { join } from 'node:path';
import { dataDir } from './config.js';
import { Fault, type Adapter } from './core/types.js';
import type { Store } from './core/store.js';

export async function health(store: Store, adapter: Adapter) {
  const records = (await store.records()).sort((a, b) => b.updated - a.updated);
  const pending = records.filter(r => ['prepared', 'sending', 'sent', 'unknown_commit', 'timed_out_after_send'].includes(r.status));
  const recent = [...pending, ...records.filter(r => !pending.includes(r)).slice(0, 5)];
  const requests = recent.map(r => ({ request_id: r.id, status: r.status, conversation_handle: r.handle, error: r.error }));
  try {
    const s = await adapter.snapshot();
    const next = !s.ordinary ? 'Open ChatGPT, sign in, and select Chat in the connected tab.'
      : pending.length ? 'Retrieve the outstanding request using its original ID and inputs, or cancel it before starting another.'
      : s.generating ? 'Wait for the current ChatGPT answer to finish.'
      : s.draft.trim() ? 'Send or clear the draft in the connected ChatGPT tab.' : undefined;
    return { browser: 'connected', ready: !next, ordinary_chat: s.ordinary, generating: s.generating,
      draft_present: !!s.draft.trim(), next_action: next, requests };
  } catch (e) {
    const code = e instanceof Fault ? e.code : 'INTERNAL_ERROR';
    const next = code === 'EXTENSION_DISCONNECTED'
      ? 'Click Open ChatGPT in the Chat MCP extension to reconnect. If missing, load extension_folder in chrome://extensions; it connects automatically.'
      : code === 'CONTENT_UNAVAILABLE' ? 'Wait for the ChatGPT tab to finish loading and check again. If this persists, reload the extension in chrome://extensions.'
      : code === 'SETUP_REQUIRED' ? 'Run npm run setup from the project folder, then reconnect the Chrome extension.'
      : code === 'BRIDGE_CONFLICT' ? 'Another Chat MCP installation is using port 9234. Stop that bridge before retrying.'
      : 'Run npm run setup from the project folder and check the connection again.';
    return { browser: 'unavailable', ready: false, error: code, next_action: next,
      extension_folder: join(dataDir, 'extension'), requests };
  }
}

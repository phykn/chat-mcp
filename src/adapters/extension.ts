import { setTimeout as sleep } from 'node:timers/promises';
import { Fault, type Adapter, type Binding, type Snapshot } from '../core/types.js';
import { ensureBridge } from '../core/bridge-process.js';
import { commandTimeout, type Command, type CommandResults, type Reply } from '../bridge-protocol.js';

export class ExtensionAdapter implements Adapter {
  private async rpc<T extends Command>(command: T): Promise<CommandResults[T['command']]> {
    // Give the extension time to reconnect after a cold start, before dispatching.
    const { url, token } = await ensureBridge(undefined, undefined, true);
    let response;
    try {
      response = await fetch(url + '/rpc', { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(command), signal: AbortSignal.timeout(commandTimeout + 5_000) });
    } catch { throw new Fault('BRIDGE_UNAVAILABLE', 'Browser command failed or timed out. Its outcome may be unknown; it was not retried.'); }
    const result = await response.json() as Reply<CommandResults[T['command']]>;
    if (result.error) throw new Fault(result.error.code, result.error.message);
    if (!response.ok) throw new Fault('BRIDGE_ERROR', `Bridge HTTP ${response.status}`);
    return result.value;
  }
  snapshot(): Promise<Snapshot> { return this.rpc({ command: 'snapshot' }); }
  async prepare(url?: string) {
    let s = await this.snapshot();
    if (s.draft.trim()) throw new Fault('DRAFT_PRESENT', 'Existing draft will not be overwritten.');
    if (s.generating) throw new Fault('BUSY', 'Current tab is generating.');
    if (url) {
      if (s.url !== url) throw new Fault('CONVERSATION_CHANGED', 'Managed conversation is no longer open.');
    } else if (s.url !== 'https://chatgpt.com/') {
      await this.rpc({ command: 'new', args: { expectedUrl: s.url } });
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try { s = await this.snapshot(); if (s.url === 'https://chatgpt.com/' && s.ordinary) break; }
        catch (e) { if (!(e instanceof Fault) || e.code !== 'CONTENT_UNAVAILABLE') throw e; }
        await sleep(300);
      }
    }
    if (!s.ordinary) throw new Fault('NOT_ORDINARY_CHAT', 'Select ordinary Chat. Login or mode verification may be required.');
    if (!url && (s.url !== 'https://chatgpt.com/' || s.messages.length)) throw new Fault('CONVERSATION_CHANGED', 'New Chat is not ready.');
    if (s.draft.trim() || s.generating) throw new Fault('BUSY', 'Composer changed during preparation.');
    return s;
  }
  async send(text: string, binding: Binding) { await this.rpc({ command: 'send', args: { text, binding } }); }
  async cancel(binding: Binding) { await this.rpc({ command: 'cancel', args: { binding } }); }
}

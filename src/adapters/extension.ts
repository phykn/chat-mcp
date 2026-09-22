import { setTimeout as sleep } from 'node:timers/promises';
import { Fault, type Adapter, type Binding, type Snapshot } from '../core/types.js';
import { ensureBridge } from '../core/bridge-process.js';
import { commandTimeoutFor, type Command, type CommandResults, type Reply } from '../bridge-protocol.js';
import { isConnectionError } from '../core/request.js';

export class ExtensionAdapter implements Adapter {
  private async rpc<T extends Command>(command: T, deadline?: number): Promise<CommandResults[T['command']]> {
    const remaining = () => {
      const ms = Math.min(commandTimeoutFor(command) + 5_000, (deadline ?? Infinity) - Date.now());
      if (ms <= 0) throw new Fault('COMMAND_EXPIRED', 'Request deadline expired before browser dispatch.');
      return Math.ceil(ms);
    };
    remaining();
    // Give the extension time to reconnect after a cold start, before dispatching.
    const { url, token } = await ensureBridge(undefined, undefined, true);
    const timeout = remaining();
    let response;
    try {
      response = await fetch(url + '/rpc', { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...command, deadline }), signal: AbortSignal.timeout(timeout) });
    } catch { throw new Fault('BRIDGE_UNAVAILABLE', 'Browser command failed or timed out. Its outcome may be unknown; it was not retried.'); }
    const result = await response.json() as Reply<CommandResults[T['command']]>;
    if (result.error) throw new Fault(result.error.code, result.error.message);
    if (!response.ok) throw new Fault('BRIDGE_ERROR', `Bridge HTTP ${response.status}`);
    return result.value;
  }
  snapshot(binding?: Binding, deadline?: number): Promise<Snapshot> {
    return this.rpc({ command: 'snapshot', ...(binding ? { args: { binding } } : {}) }, deadline);
  }
  private async ready(url?: string, deadline = Date.now() + 30_000) {
    deadline = Math.min(deadline, Date.now() + 30_000);
    let s: Snapshot | undefined;
    let error: unknown;
    do {
      try {
        s = await this.snapshot(undefined, deadline); error = undefined;
        if (s.ordinary && (!url || (s.url === url && !s.messages.length))) return s;
      } catch (e) {
        if (!(e instanceof Fault) || !isConnectionError(e.code)) throw e;
        error = e;
      }
      await sleep(300);
    } while (Date.now() < deadline);
    if (error) throw error;
    return s!;
  }
  async prepare(url?: string, deadline?: number) {
    let s = await this.ready(undefined, deadline);
    if (s.draft.trim()) throw new Fault('DRAFT_PRESENT', 'Existing draft will not be overwritten.');
    if (s.generating) throw new Fault('BUSY', 'Current tab is generating.');
    if (url) {
      if (s.url !== url) throw new Fault('CONVERSATION_CHANGED', 'Managed conversation is no longer open.');
    } else if (s.url !== 'https://chatgpt.com/') {
      try { await this.rpc({ command: 'new', args: { expectedUrl: s.url } }, deadline); }
      catch (e) {
        if (!(e instanceof Fault) || !isConnectionError(e.code)) throw e;
      }
      s = await this.ready('https://chatgpt.com/', deadline);
    }
    if (!s.ordinary) throw new Fault('NOT_ORDINARY_CHAT', 'Select ordinary Chat. Login or mode verification may be required.');
    if (!url && (s.url !== 'https://chatgpt.com/' || s.messages.length)) throw new Fault('CONVERSATION_CHANGED', 'New Chat is not ready.');
    if (s.draft.trim() || s.generating) throw new Fault('BUSY', 'Composer changed during preparation.');
    return s;
  }
  async send(text: string, binding: Binding, deadline?: number) { await this.rpc({ command: 'send', args: { text, binding } }, deadline); }
  async cancel(binding: Binding) { await this.rpc({ command: 'cancel', args: { binding } }); }
}

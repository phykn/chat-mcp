import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store, hash } from './store.js';
import { Fault, type Adapter, type Record, type Material, type Snapshot } from './types.js';
import { normalizeDraft } from './text.js';
import { isTerminal, isPending, isCancellable, isSendRejected } from './request.js';

export class Orchestrator {
  constructor(public store: Store, public adapter: Adapter,
    public timeout = 300_000, public poll = 750, public stable = 1_500) {}

  async run(input: { request_id: string; conversation_handle?: string }, collect: () => Promise<Material>) {
    const release = await this.store.lock();
    let r: Record | undefined;
    try {
      const digest = hash(input);
      r = await this.store.read(input.request_id);
      if (r && r.hash !== digest) throw new Fault('REQUEST_ID_CONFLICT', 'Same request_id has different input.');
      if (r && isTerminal(r)) return r;
      if (r && isPending(r)) {
        r.status = r.status === 'sending' ? 'unknown_commit' : r.status;
        await this.store.write(r);
        return await this.wait(r);
      }
      const records = await this.store.records();
      if (records.some(x => x.id !== input.request_id && isPending(x)))
        throw new Fault('BUSY', 'Resolve the outstanding request using the same request_id or cancel it first.');
      let url: string | undefined;
      if (input.conversation_handle) {
        const previous = records.filter(x => x.handle === input.conversation_handle && x.status === 'completed')
          .sort((a, b) => b.updated - a.updated)[0];
        if (!previous?.binding) throw new Fault('INVALID_HANDLE', 'No completed managed conversation for this handle.');
        url = previous.binding.url;
      }
      const material = await collect();
      const before = await this.adapter.prepare(url);
      if (!before.ordinary) throw new Fault('NOT_ORDINARY_CHAT', 'Ordinary Chat could not be verified.');
      r = { id: input.request_id, hash: digest, status: 'prepared', started: Date.now(), updated: Date.now(),
        handle: input.conversation_handle || randomUUID(),
        binding: { url: before.url, baseline: before.messages.map(m => m.id), marker: `[chat-mcp:${randomUUID()}]` },
        material: { scope: material.scope, files: material.files, omitted: material.omitted } };
      const text = `${r.binding!.marker}\n${material.prompt}`.trim();
      r.binding!.draftHash = hash(normalizeDraft(text));
      await this.store.write(r);
      if (await this.store.cancelled(r.id)) return await this.finish(r, 'cancelled');
      r.status = 'sending';
      await this.store.write(r);
      try { await this.adapter.send(text, r.binding!); }
      catch (e) {
        // These replies prove that the content script did not click Send.
        // Transport failures still enter recovery and must never be resent.
        if (e instanceof Fault && isSendRejected(e.code)) {
          r.status = 'failed'; r.error = { code: e.code, message: e.message };
          await this.store.write(r); return r;
        }
        throw e;
      }
      return await this.wait(r);
    } catch (e) {
      if (e instanceof Fault && e.code === 'REQUEST_ID_CONFLICT') throw e;
      if (!r || isTerminal(r)) throw e;
      const err = e instanceof Fault ? e : new Fault('UI_ERROR', String(e));
      r.error = { code: err.code, message: err.message };
      r.status = r.status === 'prepared' ? 'failed' : r.binding?.userId ? 'timed_out_after_send' : 'unknown_commit';
      await this.store.write(r);
      return r;
    } finally { await release(); }
  }

  match(r: Record, s: Snapshot) {
    const b = r.binding!;
    if (!s.ordinary) throw new Fault('NOT_ORDINARY_CHAT', 'Ordinary Chat evidence disappeared.');
    const prefix = s.messages.slice(0, b.baseline.length).map(m => m.id);
    if (JSON.stringify(prefix) !== JSON.stringify(b.baseline))
      throw new Fault('CONVERSATION_CHANGED', 'Message baseline changed or is not fully available.');
    const user = s.messages[b.baseline.length];
    if (!user || user.role !== 'user' || !user.text.includes(b.marker)) {
      if (s.url !== b.url || user) throw new Fault('CONVERSATION_CHANGED', 'Request marker is absent from current conversation.');
      return undefined;
    }
    if (b.userId && user.id !== b.userId) throw new Fault('CONVERSATION_CHANGED', 'User message identity changed.');
    if (s.url !== b.url) {
      const old = new URL(b.url), next = new URL(s.url);
      if (next.origin !== 'https://chatgpt.com' || !/^\/c\/[^/]+$/.test(next.pathname) ||
          !(old.pathname === '/' || old.pathname.startsWith('/c/WEB:')))
        throw new Fault('CONVERSATION_CHANGED', 'Conversation URL changed.');
    }
    if (s.messages.slice(b.baseline.length + 1).some(m => m.role === 'user'))
      throw new Fault('CONVERSATION_CHANGED', 'Another user message followed this request.');
    b.url = s.url; b.userId = user.id;
    const replies = s.messages.slice(b.baseline.length + 1).filter(m => m.role === 'assistant');
    return replies.at(-1);
  }

  async wait(r: Record) {
    const loadingDeadline = Date.now() + Math.min(this.timeout, 15_000);
    const deadline = Date.now() + this.timeout;
    let last = '', stableSince = Date.now();
    let hidden = false;
    let loadingError: Fault | undefined;
    while (Date.now() < deadline) {
      const s = await this.adapter.snapshot(r.binding);
      hidden = s.visible === false;
      // Navigation can mount an empty user message before its text and composer.
      // Observe without sending/cancelling until complete ownership evidence returns.
      let answer;
      try { answer = this.match(r, s); loadingError = undefined; }
      catch (e) {
        if (e instanceof Fault && ['NOT_ORDINARY_CHAT', 'CONVERSATION_CHANGED'].includes(e.code) && Date.now() < loadingDeadline) {
          loadingError = e; await sleep(this.poll); continue;
        }
        throw e;
      }
      if (r.binding?.userId && r.status !== 'sent') { r.status = 'sent'; r.error = undefined; await this.store.write(r); }
      if (await this.store.cancelled(r.id)) {
        await this.adapter.cancel(r.binding!);
        return await this.finish(r, 'cancelled', answer?.text);
      }
      if (s.error) throw new Fault('APP_ERROR', s.error);
      const fingerprint = answer ? hash(answer) : '';
      if (fingerprint !== last || s.generating || !answer?.complete) { last = fingerprint; stableSince = Date.now(); }
      if (answer?.text && answer.complete && !s.generating && Date.now() - stableSince >= this.stable &&
          !new URL(s.url).pathname.startsWith('/c/WEB:')) {
        return await this.finish(r, 'completed', answer.text);
      }
      await sleep(this.poll);
    }
    if (loadingError) throw loadingError;
    r.status = r.binding?.userId ? 'timed_out_after_send' : 'unknown_commit';
    r.error = { code: hidden ? 'PAGE_HIDDEN' : 'TIMEOUT', message: (hidden
      ? 'ChatGPT is hidden and rendering may be paused. Wake/unlock the screen and show the ChatGPT window. ' : '') +
      'Retry the identical request_id and input to retrieve the existing answer; it will not resend.' };
    r.elapsed_ms = Date.now() - r.started; await this.store.write(r); return r;
  }

  async cancel(id: string) {
    const r = await this.store.read(id);
    if (!r) throw new Fault('NOT_FOUND', 'Unknown request_id.');
    if (!isCancellable(r)) return r;
    await this.store.requestCancel(id);
    // The active worker polls this durable signal without queuing behind its own lock.
    let release;
    try { release = await this.store.lock(); }
    catch (e) { if (e instanceof Fault && e.code === 'BUSY') return { request_id: id, status: 'cancel_requested' }; throw e; }
    try {
      const current = (await this.store.read(id))!;
      if (current.status === 'prepared') return await this.finish(current, 'cancelled');
      if (!isCancellable(current)) return current;
      const s = await this.adapter.snapshot(current.binding);
      const answer = this.match(current, s);
      await this.adapter.cancel(current.binding!);
      return await this.finish(current, 'cancelled', answer?.text);
    } finally { await release(); }
  }

  private async finish(r: Record, status: 'completed' | 'cancelled', answer?: string) {
    r.status = status;
    r.answer = answer;
    r.error = undefined;
    r.elapsed_ms = Date.now() - r.started;
    await this.store.write(r);
    return r;
  }
}

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store, hash } from './store.js';
import { Fault, type Adapter, type Record, type Material, type Snapshot, type ReasoningEffort } from './types.js';
import { normalizeDraft } from './text.js';
import { isTerminal, isPending, isCancellable, isSendRejected, isConnectionError, isTemporaryChat, verifiedReasoning } from './request.js';

const recovery = 'Call chatgpt_result with this request_id to recover the existing answer without resending, or chatgpt_cancel to stop it.';

export class Orchestrator {
  constructor(public store: Store, public adapter: Adapter,
    public timeout = 300_000, public poll = 750, public stable = 1_500) {}

  async run(input: { request_id: string; conversation_handle?: string; reasoning_effort?: ReasoningEffort }, collect: () => Promise<Material>) {
    const started = Date.now();
    const cached = await this.store.read(input.request_id);
    if (cached && cached.hash !== hash(input)) throw new Fault('REQUEST_ID_CONFLICT', 'Same request_id has different input.');
    if (cached && isTerminal(cached)) return cached;
    if (cached && isPending(cached)) return this.retrieve(input.request_id);
    const release = await this.store.lock(input.request_id);
    const deadline = started + this.timeout;
    let r: Record | undefined;
    try {
      const digest = hash(input);
      r = await this.store.read(input.request_id);
      if (r && r.hash !== digest) throw new Fault('REQUEST_ID_CONFLICT', 'Same request_id has different input.');
      if (r && isTerminal(r)) return r;
      if (r && isPending(r)) {
        r.status = r.status === 'sending' ? 'unknown_commit' : r.status;
        await this.store.write(r);
        return await this.wait(r, deadline);
      }
      const records = await this.store.records();
      if (records.some(x => x.id !== input.request_id && isPending(x)))
        throw new Fault('BUSY', 'Use chatgpt_result or chatgpt_cancel for the outstanding request first.',
          { request_id: records.find(x => x.id !== input.request_id && isPending(x))!.id });
      let url: string | undefined;
      if (input.conversation_handle) {
        const previous = records.filter(x => x.handle === input.conversation_handle)
          .sort((a, b) => b.updated - a.updated)[0];
        if (!previous?.binding || previous.status !== 'completed') throw new Fault('INVALID_HANDLE',
          'The latest request for this handle is not completed. Recover its original request_id, or start a new request without conversation_handle after resolving it.',
          { request_id: previous?.id, status: previous?.status, conversation_reusable: false });
        url = previous.binding.url;
      }
      r = { id: input.request_id, hash: digest, status: 'prepared', started, updated: Date.now(),
        handle: input.conversation_handle || randomUUID(), send_state: 'not_sent',
        requested_reasoning_effort: input.reasoning_effort };
      await this.store.write(r);
      const material = await collect();
      const { prompt: _prompt, ...metadata } = material;
      r.material = metadata;
      await this.store.write(r);
      if (await this.store.cancelled(r.id)) return await this.finish(r, 'cancelled');
      const before = await this.adapter.prepare(url, deadline);
      if (!before.ordinary) throw new Fault('NOT_ORDINARY_CHAT', 'Ordinary Chat could not be verified.');
      r.binding = { url: before.url, baseline: before.messages.map(m => m.id), marker: `[chat-mcp:${randomUUID()}]` };
      const configured = await this.adapter.configure(r.binding, input.reasoning_effort, deadline);
      const applied = configured.reasoning;
      if (applied?.raw === 'pro' || applied?.raw === 'ultra')
        throw new Fault('PRO_FORBIDDEN', 'Pro reasoning is not allowed for managed requests.');
      const verified = verifiedReasoning(applied);
      if (!verified) throw new Fault('REASONING_UNAVAILABLE', 'A supported reasoning setting could not be verified before send.');
      if (input.reasoning_effort && verified !== input.reasoning_effort)
        throw new Fault('REASONING_MISMATCH', `Requested ${input.reasoning_effort} reasoning, but ${verified} is selected.`);
      r.binding.reasoning = applied;
      r.applied_reasoning = applied;
      const text = `${r.binding!.marker}\n${material.prompt}`.trim();
      r.binding!.draftHash = hash(normalizeDraft(text));
      await this.store.write(r);
      if (await this.store.cancelled(r.id)) return await this.finish(r, 'cancelled');
      if (Date.now() >= deadline) throw new Fault('TIMEOUT', 'Request preparation exceeded its deadline; send was not clicked.');
      r.status = 'sending';
      r.send_state = 'unknown';
      await this.store.write(r);
      try { await this.adapter.send(text, r.binding!, deadline); }
      catch (e) {
        // These replies prove that the content script did not click Send.
        // Transport failures still enter recovery and must never be resent.
        if (e instanceof Fault && isSendRejected(e.code)) {
          r.send_state = 'not_sent';
          r.status = 'failed'; r.error = { code: e.code, message: e.message + (e.code === 'COMMAND_EXPIRED'
            ? ' Cancel this request to clear its unchanged draft, then start a new request with a new request_id.' : '') };
          await this.store.write(r); return r;
        }
        if (!(e instanceof Fault) || !isConnectionError(e.code)) throw e;
        r.status = 'unknown_commit';
        r.error = { code: e.code, message: e.message };
        await this.store.write(r);
      }
      return await this.wait(r, deadline);
    } catch (e) {
      if (e instanceof Fault && e.code === 'REQUEST_ID_CONFLICT') throw e;
      if (!r || isTerminal(r)) throw e;
      const err = e instanceof Fault ? e : new Fault('UI_ERROR', String(e));
      r.status = r.status === 'prepared' ? 'failed' : r.binding?.userId ? 'timed_out_after_send' : 'unknown_commit';
      r.error = { code: err.code, message: err.message + (isPending(r) ? ` ${recovery}` : ''), details: err.details };
      r.elapsed_ms = Date.now() - r.started;
      await this.store.write(r);
      return r;
    } finally { await release(); }
  }

  async retrieve(id: string): Promise<Record> {
    let r = await this.store.read(id);
    if (!r) throw new Fault('NOT_FOUND', 'No durable request record exists. This does not prove an older server never sent it; retry only with the original ID and identical inputs.');
    if (isTerminal(r)) return r;
    let release;
    try { release = await this.store.lock(id); }
    catch (e) {
      if (e instanceof Fault && e.code === 'BUSY') {
        r = (await this.store.read(id))!;
        const owner = await this.store.lockInfo();
        return { ...r, active: !!owner?.active && (!owner.request_id || owner.request_id === id) };
      }
      throw e;
    }
    try {
      r = (await this.store.read(id))!;
      if (isTerminal(r)) return r;
      if (r.status === 'prepared') {
        // A worker cannot click Send until its durable status becomes sending.
        r.status = 'failed';
        r.error = { code: 'INTERRUPTED_BEFORE_SEND', message: 'Worker stopped before sending. Start a new request with a new ID.' };
        await this.store.write(r);
        return r;
      }
      return await this.wait(r, Date.now() + Math.min(this.timeout, 30_000));
    } catch (e) {
      const err = e instanceof Fault ? e : new Fault('UI_ERROR', String(e));
      r.status = r.binding?.userId ? 'timed_out_after_send' : 'unknown_commit';
      r.error = { code: err.code, message: `${err.message} ${recovery}` };
      r.elapsed_ms = Date.now() - r.started;
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
          !(old.pathname === '/' || isTemporaryChat(old.pathname)))
        throw new Fault('CONVERSATION_CHANGED', 'Conversation URL changed.');
    }
    if (s.messages.slice(b.baseline.length + 1).some(m => m.role === 'user'))
      throw new Fault('CONVERSATION_CHANGED', 'Another user message followed this request.');
    b.url = s.url; b.userId = user.id; r.send_state = 'confirmed';
    const replies = s.messages.slice(b.baseline.length + 1).filter(m => m.role === 'assistant');
    return replies.at(-1);
  }

  async wait(r: Record, deadline = Date.now() + this.timeout) {
    let last = '', stableSince = Date.now();
    let hidden = false;
    let loadingError: Fault | undefined;
    let loadingDeadline: number | undefined;
    let connectionError: Fault | undefined;
    while (Date.now() < deadline) {
      let s: Snapshot;
      try { s = await this.adapter.snapshot(r.binding, deadline); connectionError = undefined; }
      catch (e) {
        if (!(e instanceof Fault) || !isConnectionError(e.code)) throw e;
        connectionError = e;
        last = ''; stableSince = Date.now();
        await sleep(this.poll);
        continue;
      }
      hidden = s.visible === false;
      // Navigation can mount an empty user message before its text and composer.
      // Observe without sending/cancelling until complete ownership evidence returns.
      let answer;
      try { answer = this.match(r, s); loadingError = undefined; loadingDeadline = undefined; }
      catch (e) {
        if (e instanceof Fault && ['NOT_ORDINARY_CHAT', 'CONVERSATION_CHANGED'].includes(e.code)) {
          loadingDeadline ??= Math.min(deadline, Date.now() + 15_000);
          if (Date.now() < loadingDeadline) {
            loadingError = e; last = ''; stableSince = Date.now(); await sleep(this.poll); continue;
          }
        }
        throw e;
      }
      if (r.binding?.userId && r.status !== 'sent') { r.status = 'sent'; r.error = undefined; await this.store.write(r); }
      const observation = { generating: s.generating, visible: s.visible ?? null,
        answer_complete: !!answer?.text && answer.complete && !s.generating };
      if (r.answer !== answer?.text || !r.observation || Date.now() - r.observation.at >= 5_000 ||
          Object.entries(observation).some(([key, value]) => r.observation![key as keyof typeof observation] !== value)) {
        r.observation = { at: Date.now(), ...observation };
        r.answer = answer?.text;
        r.answer_complete = false;
        await this.store.write(r);
      }
      if (await this.store.cancelled(r.id)) {
        r.cancel_requested = true;
        await this.store.write(r);
        await this.adapter.cancel(r.binding!);
        return await this.finish(r, 'cancelled', answer?.text);
      }
      if (s.error) throw new Fault('APP_ERROR', s.error);
      const fingerprint = answer ? hash(answer) : '';
      if (fingerprint !== last || s.generating || !answer?.complete) { last = fingerprint; stableSince = Date.now(); }
      if (answer?.text && answer.complete && !s.generating && Date.now() - stableSince >= this.stable &&
          !isTemporaryChat(new URL(s.url).pathname)) {
        return await this.finish(r, 'completed', answer.text);
      }
      await sleep(this.poll);
    }
    if (connectionError) throw connectionError;
    if (loadingError) throw loadingError;
    r.status = r.binding?.userId ? 'timed_out_after_send' : 'unknown_commit';
    r.error = { code: hidden ? 'PAGE_HIDDEN' : 'TIMEOUT', message: (hidden
      ? 'ChatGPT is hidden and rendering may be paused. Wake/unlock the screen and show the ChatGPT window. ' : '') +
      recovery };
    r.elapsed_ms = Date.now() - r.started; await this.store.write(r); return r;
  }

  async cancel(id: string) {
    const r = await this.store.read(id);
    if (!r) throw new Fault('NOT_FOUND', 'Unknown request_id.');
    if (!isCancellable(r)) return r;
    await this.store.requestCancel(id);
    // The active worker polls this durable signal without queuing behind its own lock.
    let release;
    try { release = await this.store.lock(id); }
    catch (e) { if (e instanceof Fault && e.code === 'BUSY') return { request_id: id, status: 'cancel_requested', cancel_requested: true, answer_complete: false,
      next_action: 'Cancellation is queued, not confirmed. Retrieve this request_id; do not send a replacement.' }; throw e; }
    let current = r;
    try {
      current = (await this.store.read(id))!;
      if (current.status === 'prepared') return await this.finish(current, 'cancelled');
      if (!isCancellable(current)) return current;
      current.cancel_requested = true;
      await this.store.write(current);
      const s = await this.adapter.snapshot(current.binding);
      const answer = this.match(current, s);
      await this.adapter.cancel(current.binding!);
      return await this.finish(current, 'cancelled', answer?.text);
    } catch (e) {
      if (!(e instanceof Fault) || !isConnectionError(e.code)) throw e;
      if (current.status === 'failed') current.status = 'unknown_commit';
      current.error = { code: e.code, message: `Cancellation was requested but not confirmed. ${recovery}` };
      current.elapsed_ms = Date.now() - current.started;
      await this.store.write(current);
      return current;
    } finally { await release(); }
  }

  private async finish(r: Record, status: 'completed' | 'cancelled', answer?: string) {
    r.status = status;
    r.answer = answer;
    r.answer_complete = status === 'completed';
    r.error = undefined;
    r.elapsed_ms = Date.now() - r.started;
    await this.store.write(r);
    return r;
  }
}

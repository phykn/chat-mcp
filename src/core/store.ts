import { mkdir, open, readFile, rename, unlink, readdir, link } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Fault, type Record } from './types.js';
import { processIdentity } from './process.js';

export function hash(value: unknown): string {
  const stable = (v: any): any => Array.isArray(v) ? v.map(stable) :
    v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

export class Store {
  constructor(public dir: string) {}
  async init() { await mkdir(this.dir, { recursive: true }); }
  path(id: string) { return join(this.dir, hash(id) + '.json'); }
  async read(id: string): Promise<Record | undefined> {
    try { return JSON.parse(await readFile(this.path(id), 'utf8')); }
    catch (e: any) { if (e.code === 'ENOENT') return; throw e; }
  }
  async write(record: Record) {
    record.updated = Date.now();
    const tmp = this.path(record.id) + '.' + randomUUID() + '.tmp';
    const file = await open(tmp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(record)); await file.sync(); }
    finally { await file.close(); }
    for (let attempt = 0; ; attempt++) {
      try { await rename(tmp, this.path(record.id)); break; }
      catch (e: any) {
        // Windows readers and antivirus can briefly deny replacement. Never unlink
        // the durable destination: a retry must remain an atomic replacement.
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt >= 9) throw e;
        await sleep(10 * (attempt + 1));
      }
    }
  }
  async records(): Promise<Record[]> {
    await this.init();
    return Promise.all((await readdir(this.dir)).filter(f => f.endsWith('.json'))
      .map(async f => JSON.parse(await readFile(join(this.dir, f), 'utf8'))));
  }
  async lockInfo(path = join(this.dir, 'operation.lock')) {
    try {
      const raw = await readFile(path, 'utf8');
      let owner: { pid?: number; identity?: string; token?: string; request_id?: string; started?: number };
      try { owner = JSON.parse(raw); } catch { return { active: true }; }
      let active = true;
      if (Number.isInteger(owner.pid) && owner.pid! > 0) {
        try { process.kill(owner.pid!, 0); }
        catch (e: any) { if (e.code === 'ESRCH') active = false; }
        if (active && owner.identity) {
          const identity = await processIdentity(owner.pid!);
          if (identity && identity !== owner.identity) active = false;
        }
      }
      return { ...owner, active };
    } catch (e: any) { if (e.code === 'ENOENT') return undefined; throw e; }
  }
  async lock(request_id?: string) {
    await this.init();
    const path = join(this.dir, 'operation.lock');
    const token = randomUUID();
    const identity = await processIdentity(process.pid);
    if (!identity) throw new Fault('PROCESS_IDENTITY_UNAVAILABLE', 'Cannot verify process start identity; no operation lock was acquired.');
    const candidate = path + '.' + token + '.tmp';
    const file = await open(candidate, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ pid: process.pid, identity, token, request_id, started: Date.now() })); await file.sync(); }
    finally { await file.close(); }
    try { await this.acquireLock(candidate, path); }
    finally { await unlink(candidate); }
    return async () => { if ((await this.lockInfo())?.token === token) await unlink(path); };
  }
  private async acquireLock(candidate: string, path: string) {
    try { await link(candidate, path); }
    catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      const owner = await this.lockInfo(path);
      if (owner?.active !== false) throw new Fault('BUSY', 'A request is active. Use chatgpt_result to read its status.', owner);
      // Serialize stale-owner recovery so two processes cannot remove a new lock.
      const guardPath = path + '.recovery';
      // A crash during recovery is handled by the same ownership protocol.
      await this.acquireLock(candidate, guardPath);
      try {
        const current = await this.lockInfo(path);
        if (current?.active === false && current.token === owner.token && current.pid === owner.pid) await unlink(path);
        try { await link(candidate, path); }
        catch (e: any) { if (e.code === 'EEXIST') throw new Fault('BUSY', 'Another process acquired the operation lock.'); throw e; }
      } finally { await unlink(guardPath); }
    }
  }
  async requestCancel(id: string) {
    await this.init();
    await (await open(join(this.dir, hash(id) + '.cancel'), 'a', 0o600)).close();
  }
  async cancelled(id: string) {
    try { await readFile(join(this.dir, hash(id) + '.cancel')); return true; }
    catch (e: any) { if (e.code === 'ENOENT') return false; throw e; }
  }
}

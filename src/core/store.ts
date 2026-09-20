import { mkdir, open, readFile, rename, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Fault, type Record } from './types.js';

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
  async lock() {
    await this.init();
    const path = join(this.dir, 'operation.lock');
    let file;
    try { file = await open(path, 'wx', 0o600); }
    catch (e: any) {
      if (e.code === 'EEXIST') throw new Fault('BUSY', 'Another process owns the operation lock. After a crash run npm run recover-lock.');
      throw e;
    }
    try { await file.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID() })); await file.sync(); }
    finally { await file.close(); }
    return async () => { await unlink(path); };
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../src/core/store.js';

test('a killed worker lock is recovered automatically, but a live owner is never displaced', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-mcp-dead-owner-'));
  const module = pathToFileURL(join(process.cwd(), 'dist/core/store.js')).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { Store } from ${JSON.stringify(module)};
     await new Store(${JSON.stringify(dir)}).lock('crashed');
     console.log('locked'); setInterval(() => {}, 1000);`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve());
      child.once('error', reject);
      child.once('exit', code => reject(Error(`Worker exited before readiness (${code}): ${errors}`)));
    });
    const store = new Store(dir);
    await assert.rejects(store.lock('contender'), (e: any) => e.code === 'BUSY' && e.details.request_id === 'crashed');
    const exited = once(child, 'exit');
    child.kill(); await exited;
    assert.equal((await store.lockInfo())?.active, false);
    await copyFile(join(dir, 'operation.lock'), join(dir, 'operation.lock.recovery'));
    await copyFile(join(dir, 'operation.lock'), join(dir, 'operation.lock.recovery.recovery'));
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => new Store(dir).lock('recovered')));
    const acquired = results.filter(r => r.status === 'fulfilled');
    assert.equal(acquired.length, 1);
    assert.equal((await store.lockInfo())?.request_id, 'recovered');
    assert.equal((await store.lockInfo())?.active, true);
    await acquired[0].value();
    assert.equal(await store.lockInfo(), undefined);
  } finally { child.kill(); }
});

test('release cannot delete a subsequent owner and lock publication contains complete metadata', async () => {
  const store = new Store(await mkdtemp(join(tmpdir(), 'chat-mcp-lock-release-')));
  const release = await store.lock('first');
  assert.equal(JSON.parse(await readFile(join(store.dir, 'operation.lock'), 'utf8')).request_id, 'first');
  await release();
  const next = await store.lock('second');
  await release();
  assert.equal((await store.lockInfo())?.request_id, 'second');
  await next();
});

test('a reused PID does not keep a stale lock alive', async () => {
  const store = new Store(await mkdtemp(join(tmpdir(), 'chat-mcp-reused-pid-')));
  await writeFile(join(store.dir, 'operation.lock'), JSON.stringify({ pid: process.pid, identity: 'a-different-process-start', token: 'stale' }));
  assert.equal((await store.lockInfo())?.active, false);
  const release = await store.lock('new-owner');
  assert.equal((await store.lockInfo())?.active, true);
  assert.equal((await store.lockInfo())?.request_id, 'new-owner');
  await release();
});

import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from '../src/config.js';
const path = join(dataDir, 'requests', 'operation.lock');
try {
  const raw = await readFile(path, 'utf8');
  const { pid } = JSON.parse(raw);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid lock; inspect manually.');
  try { process.kill(pid, 0); throw new Error(`Owner PID ${pid} is alive. Lock retained.`); }
  catch (e: any) { if (e.code !== 'ESRCH') throw e; }
  if (await readFile(path, 'utf8') !== raw) throw new Error('Lock changed.');
  await unlink(path);
  console.log('Dead owner lock removed. Request records retained; retry the identical request.');
} catch (e: any) { if (e.code === 'ENOENT') console.log('No stale lock.'); else { console.error(String(e)); process.exitCode = 1; } }

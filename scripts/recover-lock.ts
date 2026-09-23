import { join } from 'node:path';
import { dataDir } from '../src/config.js';
import { Store } from '../src/core/store.js';
const store = new Store(join(dataDir, 'requests'));
try {
  const owner = await store.lockInfo();
  if (!owner) console.log('No stale lock.');
  else if (owner.active) throw new Error('Owner is alive or cannot be verified. Lock retained.');
  else {
    const release = await store.lock();
    await release();
    console.log('Dead owner lock recovered. Request records retained; use chatgpt_result with the request ID.');
  }
} catch (e) { console.error(String(e)); process.exitCode = 1; }

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

test('Windows process identity tolerates a slow query without using an unverified PID', { skip: process.platform !== 'win32' }, async () => {
  const module = pathToFileURL(join(process.cwd(), 'dist/core/process.js')).href;
  const source = `
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { promisify } from 'node:util';
    cp.execFile = () => { throw Error('Only the mocked identity query is allowed'); };
    cp.execFile[promisify.custom] = (_file, _args, options) => new Promise((resolve, reject) => {
      const expired = setTimeout(() => { clearTimeout(reply); reject(Error('Slow Windows startup')); }, options.timeout);
      const reply = setTimeout(() => { clearTimeout(expired); resolve({ stdout: 'verified-start-ticks\\n' }); }, 6000);
    });
    syncBuiltinESMExports();
    const { processIdentity } = await import(${JSON.stringify(module)});
    console.log(JSON.stringify(await processIdentity(process.pid)));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), JSON.stringify('verified-start-ticks'));
  } finally { if (child.exitCode === null) child.kill(); }
});

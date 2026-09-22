import { spawnSync } from 'node:child_process';

const files = ['tests/core.test.ts', 'tests/bridge.test.ts', 'tests/background.test.ts', 'tests/dom.test.ts', 'tests/extension.test.ts'];
for (let run = 1; run <= 10; run++) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-timeout=30000', ...files], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 4_000_000,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    if (result.error) console.error(result.error.message);
    process.exit(result.status || 1);
  }
  console.log(`Stability run ${run}/10 passed (request recovery, bridge restart, extension lifecycle, browser DOM).`);
}

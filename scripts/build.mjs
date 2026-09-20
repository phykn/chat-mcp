import { build } from 'esbuild';
await build({ entryPoints: ['extension/content.ts'], outfile: 'extension/content.js', bundle: true, format: 'iife', target: 'chrome116' });
await build({
  entryPoints: ['src/main.ts', 'src/bridge.ts'], outdir: 'dist/plugin',
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  external: ['bufferutil', 'utf-8-validate'],
});

import { spawnSync } from 'node:child_process';
import { access, cp, mkdir, readFile, readdir, writeFile, rename, open } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { preparePlugin, installPlugin } from './plugin.mjs';

export async function configure({ root, codexHome, dataDir, home = homedir(), node = process.execPath, install = installPlugin }) {
  const { parse } = await import('smol-toml');
  await mkdir(dataDir, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  const configPath = join(codexHome, 'config.toml');
  let text = '';
  try { text = await readFile(configPath, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const config = parse(text);
  const current = config.mcp_servers?.['chat-mcp'] || {};
  if (config.mcp_servers?.['chat-mcp'] && (current.url || current.args?.length !== 1 ||
      resolve(current.args[0]) !== resolve(root, 'dist', 'main.js')))
    throw Error('A different MCP server named chat-mcp already exists. Rename it before setup.');
  const template = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8')).mcpServers['chat-mcp'];
  let installed = {};
  try { installed = JSON.parse(await readFile(join(home, 'plugins', 'chat-mcp', '.mcp.json'), 'utf8')).mcpServers['chat-mcp']; }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const server = { ...installed, ...current, ...template, command: node, enabled: true,
    startup_timeout_sec: 15, tool_timeout_sec: 360,
    env: { ...installed?.env, ...current.env, CHAT_MCP_DATA_DIR: dataDir } };
  // Validate migration before changing credentials or installing anything.
  removeStandalone(text, parse);
  await migrateData(join(root, '.chat-mcp'), dataDir);
  const tokenFile = join(dataDir, 'bridge-token');
  let token;
  try { token = (await readFile(tokenFile, 'utf8')).trim(); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    token = randomBytes(32).toString('hex');
    await writeFile(tokenFile, token, { flag: 'wx', mode: 0o600 });
  }
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error('Invalid existing bridge token. Inspect it before running setup.');
  const extensionDir = join(dataDir, 'extension');
  await mkdir(extensionDir, { recursive: true });
  const digest = createHash('sha256');
  for (const file of ['manifest.json', 'background.js', 'popup.html', 'popup.js', 'content.js']) {
    digest.update(await readFile(join(root, 'extension', file)));
    await cp(join(root, 'extension', file), join(extensionDir, file));
  }
  const revision = digest.digest('hex');
  const extensionConfig = `export const token = ${JSON.stringify(token)};\nexport const revision = ${JSON.stringify(revision)};\n`;
  await writeFile(join(extensionDir, 'config.js'), extensionConfig, { mode: 0o600 });
  // Keep an already-loaded extension from the old checkout location usable during migration.
  const legacyConfig = join(root, 'extension', 'config.js');
  try {
    if ((await readFile(legacyConfig, 'utf8')).includes(`export const token = ${JSON.stringify(token)};`))
      await writeFile(legacyConfig, extensionConfig, { mode: 0o600 });
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const plugin = await preparePlugin({ root, home, server });
  await install(plugin.selector, codexHome);
  // Publish only after all extension files and the plugin have been installed.
  await writeFile(join(dataDir, 'extension-revision'), revision);
  // A user-level server with the same name overrides the bundled server, even when disabled.
  let latest = '';
  try { latest = await readFile(configPath, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!isDeepStrictEqual(parse(latest).mcp_servers?.['chat-mcp'], config.mcp_servers?.['chat-mcp']))
    throw Error('The standalone MCP config changed during setup. Run setup again.');
  const next = removeStandalone(latest, parse);
  if (next === latest) return { ...plugin, extensionDir };
  const tmp = configPath + `.chat-mcp-${process.pid}.tmp`;
  const file = await open(tmp, 'wx', 0o600);
  try { await file.writeFile(next); await file.sync(); } finally { await file.close(); }
  if (await readFile(configPath, 'utf8') !== latest) throw Error('Codex config changed during setup. Run setup again.');
  await rename(tmp, configPath);
  return { ...plugin, extensionDir };
}

async function migrateData(legacy, dir) {
  if (resolve(legacy) === resolve(dir)) return;
  let token, current;
  try { token = await readFile(join(legacy, 'bridge-token'), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return; throw e; }
  try { current = await readFile(join(dir, 'bridge-token'), 'utf8'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (current && current.trim() !== token.trim()) return;
  for (const root of [legacy, dir]) {
    try { await access(join(root, 'requests', 'operation.lock')); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    throw Error('A Chat MCP request holds a lock in ' + root + '. Resolve that request before setup.');
  }
  let files = [];
  try { files = await readdir(join(legacy, 'requests')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  await mkdir(join(dir, 'requests'), { recursive: true });
  for (const file of files.filter(f => /\.(json|cancel)$/.test(f))) {
    // Existing destination records may be newer; only fill missing records on a retry.
    await cp(join(legacy, 'requests', file), join(dir, 'requests', file), { force: false });
  }
  if (!current) await cp(join(legacy, 'bridge-token'), join(dir, 'bridge-token'), { errorOnExist: true, force: false });
}

function removeStandalone(text, parse) {
  const config = parse(text), current = config.mcp_servers?.['chat-mcp'];
  if (!current) return text;
  const header = /^\s*\[mcp_servers\.(?:chat-mcp|"chat-mcp"|'chat-mcp')(?:\.[^\]]+)?\]\s*(?:#.*)?$/;
  let skip = false, found = false;
  const kept = text.split(/\r?\n/).filter(line => {
    if (/^\s*\[/.test(line)) { skip = header.test(line); if (skip) found = true; }
    return !skip;
  });
  if (!found) throw Error('Unsupported chat-mcp table layout; no config was changed.');
  const next = kept.join('\n').trimEnd() + '\n';
  const expected = { ...config, mcp_servers: { ...config.mcp_servers } };
  delete expected.mcp_servers['chat-mcp'];
  const parsed = parse(next);
  if (!Object.keys(expected.mcp_servers).length && !parsed.mcp_servers) delete expected.mcp_servers;
  if (!isDeepStrictEqual(parsed, expected)) throw Error('Config preservation check failed; no config was changed.');
  return next;
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22)
    throw Error('Node.js 22 이상을 설치하고 터미널을 다시 연 뒤 npm run setup을 실행하세요.');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const dataDir = resolve(process.env.CHAT_MCP_DATA_DIR || join(homedir(), '.chat-mcp'));
  const codexHome = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
  const npm = process.env.npm_execpath;
  if (!npm) throw Error('Run this installer with npm run setup.');
  function run(args) {
    const result = spawnSync(process.execPath, [npm, ...args], { cwd: root, stdio: 'inherit', windowsHide: true });
    if (result.error || result.status !== 0) throw Error(`npm ${args.join(' ')} failed; setup stopped.`);
  }
  console.log('Chat MCP 설치를 시작합니다. 플러그인 등록과 실행 파일 준비를 자동으로 진행합니다.');
  console.log('\n[1/4] 의존성 설치');
  run(['ci', '--include=dev']);
  console.log('\n[2/4] MCP 서버와 Chrome 확장 빌드');
  run(['run', 'build']);
  console.log('\n[3/4] Codex 플러그인 설치 및 Chrome 확장 준비');
  const plugin = await configure({ root, codexHome, dataDir });
  console.log(`설치 완료: ${plugin.selector}`);
  const { finishSetup } = await import('./onboarding.mjs');
  await finishSetup({ extensionDir: plugin.extensionDir,
    interactive: !process.argv.includes('--non-interactive') && !!(process.stdin.isTTY && process.stdout.isTTY) });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Setup failed: ${error.message}`); process.exitCode = 1; });
}

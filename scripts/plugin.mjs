import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, delimiter } from 'node:path';

export async function preparePlugin({ root, home, server }) {
  const dir = join(home, 'plugins', 'chat-mcp');
  const catalog = join(home, '.agents', 'plugins', 'marketplace.json');
  let marketplace;
  try { marketplace = JSON.parse(await readFile(catalog, 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    marketplace = { name: 'personal', interface: { displayName: 'Personal' }, plugins: [] };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(marketplace.name) || !Array.isArray(marketplace.plugins))
    throw Error('Invalid personal plugin marketplace. No plugin was installed.');
  const entry = marketplace.plugins.find(p => p.name === 'chat-mcp');
  if (entry && (entry.source?.source !== 'local' || entry.source.path !== './plugins/chat-mcp'))
    throw Error('A different chat-mcp plugin already exists in the personal marketplace.');

  const manifest = JSON.parse(await readFile(join(root, '.codex-plugin', 'plugin.json'), 'utf8'));
  if (manifest.name !== 'chat-mcp') throw Error('Invalid Chat MCP plugin name.');
  manifest.version = manifest.version.split('+')[0] + '+codex.' + Date.now();
  // Only ship the runtime and instructions. Requests and credentials stay outside the plugin.
  await access(join(root, 'dist', 'plugin', 'main.js'));
  await access(join(root, 'dist', 'plugin', 'bridge.js'));
  const mcp = JSON.stringify({ mcpServers: { 'chat-mcp': server } }, null, 2) + '\n';
  await mkdir(join(dir, '.codex-plugin'), { recursive: true });
  await cp(join(root, 'dist', 'plugin'), join(dir, 'dist', 'plugin'), { recursive: true });
  await cp(join(root, 'skills'), join(dir, 'skills'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n');
  await writeFile(join(dir, '.codex-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(dir, '.mcp.json'), mcp);
  if (!entry) {
    marketplace.plugins.push({ name: 'chat-mcp', source: { source: 'local', path: './plugins/chat-mcp' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' });
    await mkdir(join(home, '.agents', 'plugins'), { recursive: true });
    await writeFile(catalog, JSON.stringify(marketplace, null, 2) + '\n');
  }
  return { selector: `chat-mcp@${marketplace.name}`, dir, catalog };
}

export async function installPlugin(selector, codexHome) {
  const env = { ...process.env, CODEX_HOME: codexHome };
  let command = 'codex', prefix = [];
  if (process.platform === 'win32') {
    command = '';
    for (const dir of (process.env.PATH || '').split(delimiter)) {
      for (const file of ['codex.exe', 'node_modules/@openai/codex/bin/codex.js']) {
        const path = join(dir.replace(/^"|"$/g, ''), file);
        try { await access(path); } catch { continue; }
        command = file.endsWith('.js') ? process.execPath : path;
        prefix = file.endsWith('.js') ? [path] : [];
        break;
      }
      if (command) break;
    }
  }
  const options = { env, stdio: 'inherit', windowsHide: true };
  let result = command ? spawnSync(command, [...prefix, 'plugin', 'add', selector], options) : undefined;
  if (!result || result.error?.code === 'ENOENT') {
    const npm = process.env.npm_execpath;
    if (!npm) throw Error('Run npm run setup so it can install the Codex CLI automatically.');
    console.log('Preparing the Codex CLI for plugin installation…');
    result = spawnSync(process.execPath, [npm, 'exec', '--yes', '--package=@openai/codex', '--', 'codex', 'plugin', 'add', selector], options);
  }
  if (result.error || result.status !== 0) throw Error('Plugin installation failed. Check the Codex CLI and rerun setup.');
}

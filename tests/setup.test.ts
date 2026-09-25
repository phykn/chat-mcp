import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, cp, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { configure } from '../scripts/setup.mjs';
import { diagnose, checkMcp } from '../scripts/doctor.mjs';
import { finishSetup } from '../scripts/onboarding.mjs';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'chat-mcp-setup space-'));
  const codexHome = join(root, 'codex'), dataDir = join(root, 'data');
  await mkdir(join(root, 'extension')); await mkdir(codexHome);
  await mkdir(join(root, '.codex-plugin'));
  await copyFile(new URL('../.codex-plugin/plugin.json', import.meta.url), join(root, '.codex-plugin', 'plugin.json'));
  await copyFile(new URL('../.mcp.json', import.meta.url), join(root, '.mcp.json'));
  await cp(new URL('../skills', import.meta.url), join(root, 'skills'), { recursive: true });
  await cp(new URL('../dist/plugin', import.meta.url), join(root, 'dist', 'plugin'), { recursive: true });
  for (const file of ['manifest.json', 'background.js', 'popup.html', 'popup.js', 'content.js'])
    await copyFile(new URL('../extension/' + file, import.meta.url), join(root, 'extension', file));
  const install = async (selector: string) => {
    assert.equal(selector, 'chat-mcp@personal');
    const file = join(codexHome, 'config.toml');
    let text = '';
    try { text = await readFile(file, 'utf8'); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    if (!text.includes('[plugins.')) await writeFile(file, text + '\n[plugins."chat-mcp@personal"]\nenabled = true\n');
  };
  return { root, codexHome, dataDir, home: join(root, 'home'), install };
}
test('setup preserves unrelated config, existing server settings and token on reinstall', async () => {
  const options = await fixture();
  const file = join(options.codexHome, 'config.toml');
  const unrelated = '# Keep this comment\nmodel = "example"\n\n[mcp_servers.other]\ncommand = "other"\n';
  await writeFile(file, unrelated + `\n[mcp_servers.chat-mcp]\ncommand = "old"\nargs = [${JSON.stringify(join(options.root, 'dist', 'main.js'))}]\ndisabled_tools = ["chatgpt_cancel"]\n[mcp_servers.chat-mcp.env]\nCUSTOM = "keep"\n`);
  const plugin = await configure(options);
  const first = await readFile(file, 'utf8'), token = await readFile(join(options.dataDir, 'bridge-token'), 'utf8');
  assert.ok(first.startsWith(unrelated));
  assert.equal((parse(first).mcp_servers as any)['chat-mcp'], undefined);
  assert.equal((parse(first).plugins as any)['chat-mcp@personal'].enabled, true);
  const server = JSON.parse(await readFile(join(plugin.dir, '.mcp.json'), 'utf8')).mcpServers;
  assert.equal(server['chat-mcp'].enabled, true);
  assert.equal(server['chat-mcp'].tool_timeout_sec, 360);
  assert.equal(server['chat-mcp'].env.CUSTOM, 'keep');
  assert.deepEqual(server['chat-mcp'].disabled_tools, ['chatgpt_cancel']);
  assert.deepEqual(server['chat-mcp'].args, ['dist/plugin/main.js']);
  assert.equal(server['chat-mcp'].cwd, '.');
  await configure(options);
  assert.equal(await readFile(join(options.dataDir, 'bridge-token'), 'utf8'), token);
  assert.deepEqual(parse(await readFile(file, 'utf8')), parse(first));
  const reinstalled = JSON.parse(await readFile(join(plugin.dir, '.mcp.json'), 'utf8')).mcpServers['chat-mcp'];
  assert.equal(reinstalled.env.CUSTOM, 'keep');
  assert.deepEqual(reinstalled.disabled_tools, ['chatgpt_cancel']);
});
test('fresh plugin setup registers one catalog entry and keeps credentials out of the plugin', async () => {
  const options = await fixture();
  const plugin = await configure(options);
  assert.equal(parse(await readFile(join(options.codexHome, 'config.toml'), 'utf8')).mcp_servers, undefined);
  const mcp = await readFile(join(plugin.dir, '.mcp.json'), 'utf8');
  assert.equal(JSON.parse(mcp).mcpServers['chat-mcp'].command, process.execPath);
  assert.ok(!mcp.includes(await readFile(join(options.dataDir, 'bridge-token'), 'utf8')));
  assert.match(await readFile(join(plugin.extensionDir, 'config.js'), 'utf8'), /^export const token = "[a-f0-9]{64}";/);
  await configure(options);
  assert.equal(JSON.parse(await readFile(plugin.catalog, 'utf8')).plugins.length, 1);
});

test('installed plugin starts from another folder without source files or node_modules', async () => {
  const options = await fixture(), plugin = await configure(options);
  const dir = await mkdtemp(join(tmpdir(), 'chat-mcp-relocated space-'));
  await cp(plugin.dir, dir, { recursive: true });
  const server = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8')).mcpServers['chat-mcp'];
  const client = new Client({ name: 'installed-plugin-test', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: server.command,
      args: server.args, cwd: join(dir, server.cwd), env: server.env, stderr: 'pipe' }));
    assert.ok(client.getInstructions());
    assert.ok((await client.listTools()).tools.some(tool => tool.name === 'chatgpt_preview'));
    assert.match(await readFile(join(dir, 'skills', 'chat-mcp', 'SKILL.md'), 'utf8'), /name: chat-mcp/);
  } finally { await client.close(); }
});

test('setup preserves old request records and pairing when moving out of the checkout', async () => {
  const options = await fixture(), legacy = join(options.root, '.chat-mcp');
  await mkdir(join(legacy, 'requests'), { recursive: true });
  await writeFile(join(legacy, 'bridge-token'), 'a'.repeat(64));
  await writeFile(join(legacy, 'requests', 'record.json'), '{"status":"unknown_commit"}');
  await mkdir(join(options.dataDir, 'requests'), { recursive: true });
  await configure(options);
  assert.equal(await readFile(join(options.dataDir, 'bridge-token'), 'utf8'), 'a'.repeat(64));
  assert.equal(await readFile(join(options.dataDir, 'requests', 'record.json'), 'utf8'), '{"status":"unknown_commit"}');
  await writeFile(join(options.dataDir, 'requests', 'record.json'), '{"status":"completed"}');
  await configure(options);
  assert.equal(await readFile(join(options.dataDir, 'requests', 'record.json'), 'utf8'), '{"status":"completed"}');
});
test('malformed or conflicting config remains untouched', async () => {
  for (const content of ['invalid = [', '[mcp_servers.chat-mcp]\nurl = "https://example.invalid"\n']) {
    const options = await fixture(), file = join(options.codexHome, 'config.toml');
    await writeFile(file, content);
    await assert.rejects(configure(options));
    assert.equal(await readFile(file, 'utf8'), content);
  }
});

test('failed plugin installation leaves the standalone server enabled', async () => {
  const options = await fixture(), file = join(options.codexHome, 'config.toml');
  const text = `[mcp_servers.chat-mcp]\ncommand = "node"\nargs = [${JSON.stringify(join(options.root, 'dist', 'main.js'))}]\nenabled = true\n`;
  await writeFile(file, text);
  await assert.rejects(configure({ ...options, install: async () => { throw Error('install failed'); } }), /install failed/);
  assert.equal(await readFile(file, 'utf8'), text);
});

test('plugin setup preserves unrelated catalog entries and refuses a conflicting source', async () => {
  const options = await fixture();
  const catalog = join(options.home, '.agents', 'plugins', 'marketplace.json');
  await mkdir(join(options.home, '.agents', 'plugins'), { recursive: true });
  const other = { name: 'other', source: { source: 'local', path: './plugins/other' } };
  await writeFile(catalog, JSON.stringify({ name: 'personal', interface: { displayName: 'My Plugins' }, plugins: [other] }));
  await configure(options);
  const saved = JSON.parse(await readFile(catalog, 'utf8'));
  assert.deepEqual(saved.plugins[0], other);
  assert.equal(saved.interface.displayName, 'My Plugins');
  saved.plugins[1].source.path = './plugins/somewhere-else';
  const conflicting = JSON.stringify(saved);
  await writeFile(catalog, conflicting);
  await assert.rejects(configure(options), /different chat-mcp plugin/);
  assert.equal(await readFile(catalog, 'utf8'), conflicting);
});

test('doctor checks setup and activation before starting MCP', async () => {
  const options = await fixture();
  let calls = 0;
  const probe = async () => { calls++; return { ready: true, browser: 'connected' }; };
  assert.equal((await diagnose({ ...options, probe })).code, 'SETUP_REQUIRED');
  await configure(options);
  const file = join(options.codexHome, 'config.toml');
  await writeFile(file, '[plugins."chat-mcp@personal"]\nenabled = false\n');
  assert.equal((await diagnose({ ...options, probe })).code, 'PLUGIN_DISABLED');
  assert.equal(calls, 0);
  await configure(options);
  await writeFile(file, '[plugins."chat-mcp@personal"]\nenabled = true\n');
  const ready = await diagnose({ ...options, probe });
  assert.equal(ready.ready, true);
  assert.equal(calls, 1);
});

test('doctor points to the prepared extension and explains login and busy states', async () => {
  const options = await fixture(), plugin = await configure(options);
  const check = (state: object) => diagnose({ ...options, probe: async () => state });
  const disconnected = await check({ ready: false, browser: 'unavailable', error: 'EXTENSION_DISCONNECTED' });
  assert.equal(disconnected.ready, false);
  assert.ok(disconnected.message.includes(plugin.extensionDir));
  assert.ok(!disconnected.message.includes(join(options.root, 'extension')));
  const login = await check({ ready: false, browser: 'connected', ordinary_chat: false });
  assert.match(login.message, /로그인/);
  const busy = await check({ ready: false, browser: 'connected', ordinary_chat: true, generating: true });
  assert.match(busy.message, /답변 중/);
  const draft = await check({ ready: false, browser: 'connected', ordinary_chat: true, draft_present: true });
  assert.match(draft.message, /입력창/);
  const pending = await check({ ready: false, browser: 'connected', ordinary_chat: true, requests: [{ status: 'unknown_commit' }] });
  assert.match(pending.message, /기존 요청/);
});

test('doctor rejects a duplicate marketplace plugin or standalone override', async () => {
  const options = await fixture();
  await configure(options);
  const file = join(options.codexHome, 'config.toml'), original = await readFile(file, 'utf8');
  const probe = async () => { assert.fail('must not start MCP with conflicting configuration'); };
  await writeFile(file, original + '\n[plugins."chat-mcp@chat-mcp"]\nenabled = true\n');
  assert.equal((await diagnose({ ...options, probe })).code, 'DUPLICATE_PLUGIN');
  await writeFile(file, original + '\n[mcp_servers.chat-mcp]\ncommand = "old"\n');
  assert.equal((await diagnose({ ...options, probe })).code, 'SERVER_OVERRIDE');
  assert.equal(await readFile(file, 'utf8'), original + '\n[mcp_servers.chat-mcp]\ncommand = "old"\n');
});

test('doctor reports missing extension files and a failed MCP launch', async () => {
  const options = await fixture(), plugin = await configure(options);
  const failed = await diagnose({ ...options, probe: async () => { throw Error('launch failed'); } });
  assert.equal(failed.code, 'MCP_UNAVAILABLE');
  assert.equal(failed.ready, false);
  await unlink(join(plugin.extensionDir, 'config.js'));
  const missing = await diagnose({ ...options, probe: async () => { assert.fail('must not start MCP'); } });
  assert.equal(missing.code, 'SETUP_REQUIRED');
  assert.match(missing.message, /확장 파일/);
});

test('doctor starts MCP over stdio and calls only health', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-mcp-diagnose space-'));
  const code = `
    import { McpServer } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/mcp.js'))};
    import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
    const server = new McpServer({name:'doctor-fixture',version:'1'});
    server.registerTool('chatgpt_health', {inputSchema:{}}, () => ({content:[{type:'text',text:JSON.stringify({ready:true,browser:'connected'})}]}));
    await server.connect(new StdioServerTransport());
  `;
  await writeFile(join(root, 'server.mjs'), code);
  const result = await checkMcp(root, { command: process.execPath, args: ['server.mjs'], cwd: '.' });
  assert.equal(result.ready, true);
});

test('setup does not open windows or wait for input when already ready or unattended', async t => {
  t.mock.method(console, 'log', () => {});
  const open = async () => { assert.fail('must not open browser'); };
  const extensionDir = 'prepared extension';
  const ready = { ready: true, checks: [], message: 'ready' };
  assert.equal((await finishSetup({ extensionDir, interactive: true, open, check: async () => ready })).ready, true);
  const waiting = { ready: false, checks: [], code: 'EXTENSION_DISCONNECTED', message: 'waiting' };
  assert.equal((await finishSetup({ extensionDir, interactive: false, open, check: async () => waiting })).ready, false);
});

test('setup rechecks after the Chrome step without reinstalling the plugin', async t => {
  t.mock.method(console, 'log', () => {});
  const input = new PassThrough(), output = new PassThrough();
  let calls = 0, opened = '';
  output.on('data', () => { setImmediate(() => input.write('\n')); });
  const state = await finishSetup({ extensionDir: 'prepared extension', interactive: true, input, output,
    open: async dir => { opened = dir; return true; },
    check: async () => ++calls === 1
      ? { ready: false, checks: [], code: 'EXTENSION_DISCONNECTED', message: 'waiting' }
      : { ready: true, checks: [], message: 'ready' } });
  assert.equal(opened, 'prepared extension');
  assert.equal(calls, 2);
  assert.equal(state.ready, true);
  input.destroy(); output.destroy();
});

test('setup can defer connection without reporting success', async t => {
  t.mock.method(console, 'log', () => {});
  const input = new PassThrough(), output = new PassThrough();
  output.on('data', () => { setImmediate(() => input.write('q\n')); });
  let calls = 0;
  const state = await finishSetup({ extensionDir: 'prepared extension', interactive: true, input, output,
    open: async () => false,
    check: async () => { calls++; return { ready: false, checks: [], code: 'EXTENSION_DISCONNECTED', message: 'waiting' }; } });
  assert.equal(calls, 1);
  assert.equal(state.ready, false);
  input.destroy(); output.destroy();
});

import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function checkMcp(dir, server) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'chat-mcp-setup', version: '1' });
  const transport = new StdioClientTransport({ command: server.command, args: server.args,
    cwd: resolve(dir, server.cwd || '.'), env: { ...process.env, ...server.env }, stderr: 'pipe' });
  // Drain diagnostics without printing paths, credentials, or browser content.
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport, { timeout: 10_000 });
    const reply = await client.callTool({ name: 'chatgpt_health', arguments: {} }, undefined, { timeout: 35_000 });
    const text = reply.content?.find(item => item.type === 'text')?.text;
    if (!text || reply.isError) throw Error('MCP health check failed.');
    return JSON.parse(text);
  } finally { await client.close(); }
}

export async function diagnose({ home = homedir(),
  codexHome = resolve(process.env.CODEX_HOME || join(home, '.codex')),
  probe = checkMcp } = {}) {
  const dir = join(home, 'plugins', 'chat-mcp');
  const checks = [];
  const stop = (code, message) => ({ ready: false, code, checks, message });
  let server, selector;
  try {
    const catalog = JSON.parse(await readFile(join(home, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
    const entry = catalog.plugins.find(p => p.name === 'chat-mcp');
    if (entry?.source?.source !== 'local' || entry.source.path !== './plugins/chat-mcp')
      return stop('SETUP_REQUIRED', '로컬 설치가 필요합니다. 이 저장소에서 npm run setup을 실행하세요.');
    selector = `chat-mcp@${catalog.name}`;
    server = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8')).mcpServers['chat-mcp'];
    for (const path of ['.codex-plugin/plugin.json', 'dist/plugin/main.js', 'dist/plugin/bridge.js'])
      await access(join(dir, path));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return stop('SETUP_REQUIRED', '로컬 설치가 필요합니다. 이 저장소에서 npm run setup을 실행하세요.');
  }
  const { parse } = await import('smol-toml');
  let config = {};
  try { config = parse(await readFile(join(codexHome, 'config.toml'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (config.plugins?.[selector]?.enabled !== true || server.enabled === false)
    return stop('PLUGIN_DISABLED', `Codex에서 ${selector} 플러그인을 활성화하거나 npm run setup을 다시 실행하세요.`);
  if (config.mcp_servers?.['chat-mcp'])
    return stop('SERVER_OVERRIDE', '기존 chat-mcp MCP 설정이 플러그인보다 우선합니다. npm run setup으로 이전 설정을 정리하세요.');
  if (Object.entries(config.plugins || {}).some(([name, value]) => name.startsWith('chat-mcp@') && name !== selector && value.enabled))
    return stop('DUPLICATE_PLUGIN', `Chat MCP가 두 곳에서 활성화되어 있습니다. Codex에서 ${selector}만 켜 두세요.`);
  checks.push('Codex 플러그인 설치 및 활성화');
  const dataDir = resolve(server.env?.CHAT_MCP_DATA_DIR || process.env.CHAT_MCP_DATA_DIR || join(home, '.chat-mcp'));
  const extensionDir = join(dataDir, 'extension');
  try {
    for (const path of ['manifest.json', 'background.js', 'popup.html', 'popup.js', 'content.js', 'config.js'])
      await access(join(extensionDir, path));
    await access(join(dataDir, 'bridge-token'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return stop('SETUP_REQUIRED', 'Chrome 확장 파일이 부족합니다. npm run setup을 다시 실행하세요.');
  }
  checks.push('Chrome 확장 파일 준비');
  let state;
  try { state = await probe(dir, server); }
  catch { return stop('MCP_UNAVAILABLE', 'MCP 서버를 시작하지 못했습니다. npm run setup을 다시 실행한 뒤 확인하세요.'); }
  checks.push('MCP 서버 실행');
  if (state.browser === 'connected') checks.push('Chrome 확장 연결');
  if (state.ready === true && state.browser === 'connected')
    return { ready: true, checks, message: '연결 확인 완료. 새 Codex 작업에서 "Chat MCP로 변경사항 리뷰해줘"라고 요청하세요.' };
  const actions = {
    EXTENSION_DISCONNECTED: `Chrome에서 확장을 연결하세요. chrome://extensions → 개발자 모드 → 압축해제된 확장 프로그램 로드\n선택할 폴더: ${extensionDir}\n이미 로드했다면 확장 아이콘 → Open ChatGPT를 누르세요.`,
    CONTENT_UNAVAILABLE: 'ChatGPT 페이지가 로드될 때까지 기다리세요. 계속 실패하면 chrome://extensions에서 Chat MCP를 새로고침하세요.',
    SETUP_REQUIRED: 'npm run setup을 먼저 실행하세요.',
    BRIDGE_CONFLICT: '다른 Chat MCP 설치가 연결 포트를 사용 중입니다. 기존 브리지를 종료한 뒤 다시 확인하세요.',
    BRIDGE_VERSION: '이전 버전의 브리지가 실행 중입니다. 기존 브리지를 종료한 뒤 다시 확인하세요.',
  };
  const message = actions[state.error] || (state.browser !== 'connected'
    ? '연결 상태를 확인할 수 없습니다. npm run setup을 다시 실행하세요.'
    : !state.ordinary_chat ? '연결된 ChatGPT 탭에서 로그인하고 Chat 모드를 선택하세요.'
    : state.requests?.some(r => !['completed', 'failed', 'cancelled'].includes(r.status))
      ? '진행 중인 요청이 있습니다. Codex에서 기존 요청의 결과를 확인하거나 취소한 뒤 다시 확인하세요.'
    : state.generating ? 'ChatGPT가 답변 중입니다. 답변이 끝나면 다시 확인하세요.'
    : state.draft_present ? 'ChatGPT 입력창에 작성 중인 내용이 있습니다. 직접 보내거나 지운 뒤 다시 확인하세요.'
    : '새 Codex 작업에서 "Chat MCP 연결 상태 확인해줘"라고 요청하세요.');
  return stop(state.error || 'NOT_READY', message);
}

export function printDiagnosis(state) {
  for (const check of state.checks) console.log(`  [확인] ${check}`);
  console.log(`\n${state.ready ? '[사용 준비 완료]' : '[확인 필요]'} ${state.message}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  diagnose().then(state => { printDiagnosis(state); process.exitCode = state.ready ? 0 : 1; })
    .catch(() => { console.error('설치 상태를 읽지 못했습니다. 저장소에서 npm run setup을 다시 실행하세요.'); process.exitCode = 1; });
}

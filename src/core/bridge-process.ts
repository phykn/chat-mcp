import { spawn } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { dataDir, bridgeScript } from '../config.js';
import { Fault } from './types.js';
import { bridgePort, bridgeProtocol, bridgeUrl } from '../bridge-protocol.js';

export async function ensureBridge(dir = dataDir, port = bridgePort, waitForExtension = false) {
  let token: string;
  try { token = (await readFile(join(dir, 'bridge-token'), 'utf8')).trim(); }
  catch (e: any) { if (e.code === 'ENOENT') throw new Fault('SETUP_REQUIRED', 'Run npm run setup first.'); throw e; }
  const url = bridgeUrl(port);
  const connection = { url, token };
  let connected = false;
  async function probe() {
    let response;
    try { response = await fetch(url + '/health', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1_500) }); }
    catch (e: any) {
      if (e.cause?.code === 'ECONNREFUSED') return false;
      throw new Fault('BRIDGE_UNAVAILABLE', 'Bridge health check failed. No browser command was retried.');
    }
    if (response.status === 403) throw new Fault('BRIDGE_CONFLICT', `Port ${port} belongs to a bridge with different credentials.`);
    let health: any;
    try { health = await response.json(); } catch { /* Reject unrelated services. */ }
    if (!response.ok || health?.service !== 'chat-mcp' || health?.protocol !== bridgeProtocol)
      throw new Fault('BRIDGE_VERSION', 'An incompatible service is using the bridge port. Stop the old bridge and retry.');
    connected = health.connected === true;
    return true;
  }
  async function ready() {
    const deadline = Date.now() + 5_000;
    while (waitForExtension && !connected && Date.now() < deadline) {
      await sleep(300);
      if (!await probe()) break;
    }
    return connection;
  }
  if (await probe()) return ready();
  const log = await open(join(dir, 'bridge.log'), 'a', 0o600);
  let launchError: Error | undefined;
  try {
    const child = spawn(process.execPath, [bridgeScript], {
      env: { ...process.env, CHAT_MCP_DATA_DIR: dir, CHAT_MCP_BRIDGE_PORT: String(port) },
      detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
    });
    child.on('error', e => { launchError = e; });
    child.unref();
  } finally { await log.close(); }
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (launchError) throw new Fault('BRIDGE_START_FAILED', launchError.message);
    if (await probe()) return ready();
    await sleep(150);
  }
  throw new Fault('BRIDGE_START_FAILED', 'Bridge did not start. Check .chat-mcp/bridge.log.');
}

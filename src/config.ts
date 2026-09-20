import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export const dataDir = resolve(process.env.CHAT_MCP_DATA_DIR || resolve(homedir(), '.chat-mcp'));
export const bridgeScript = fileURLToPath(new URL('./bridge.js', import.meta.url));
export const maxBytes = 48_000;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('blank prompts, IDs and supplied handles are rejected before browser access', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-mcp-invalid-input-'));
  const client = new Client({ name: 'invalid-input-test', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../dist/main.js', import.meta.url))],
      env: { ...process.env, CHAT_MCP_DATA_DIR: dir } as any, stderr: 'pipe' }));
    for (const args of [
      { request_id: 'blank-prompt', prompt: ' \n\t' },
      { request_id: ' \t', prompt: 'OK' },
      { request_id: 'empty-handle', prompt: 'OK', conversation_handle: '' },
      { request_id: 'blank-handle', prompt: 'OK', conversation_handle: '  ' },
    ]) {
      const r = await client.callTool({ name: 'chatgpt_ask', arguments: args });
      assert.equal(r.isError, true);
      assert.match((r.content as any[])[0].text, /Input validation error/);
    }
  } finally { await client.close(); }
});

test('real STDIO MCP startup, tool schemas and health', async () => {
  const client = new Client({ name: 'test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/main.js', import.meta.url))], stderr: 'pipe' });
  try {
    await client.connect(transport);
    assert.ok(client.getInstructions());
    assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(),
      ['chatgpt_ask', 'chatgpt_cancel', 'chatgpt_health', 'chatgpt_result', 'review_with_chatgpt']);
    const result = await client.callTool({ name: 'chatgpt_health', arguments: {} });
    const text = (result.content as any[])[0].text;
    assert.ok(['connected', 'unavailable'].includes(JSON.parse(text).browser));
    assert.equal(result.isError, false);
    const invalid = await client.callTool({ name: 'chatgpt_ask', arguments: {} });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); }
});

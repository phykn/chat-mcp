import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

test('real STDIO MCP startup, tool schemas and health', async () => {
  const client = new Client({ name: 'test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../dist/main.js', import.meta.url))], stderr: 'pipe' });
  try {
    await client.connect(transport);
    assert.ok(client.getInstructions());
    assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(),
      ['chatgpt_ask', 'chatgpt_cancel', 'chatgpt_health', 'review_with_chatgpt']);
    const result = await client.callTool({ name: 'chatgpt_health', arguments: {} });
    const text = (result.content as any[])[0].text;
    assert.ok(['connected', 'unavailable'].includes(JSON.parse(text).browser));
    assert.equal(result.isError, false);
    const invalid = await client.callTool({ name: 'chatgpt_ask', arguments: {} });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); }
});

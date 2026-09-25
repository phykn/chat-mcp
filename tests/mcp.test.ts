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
      { request_id: 'pro', prompt: 'OK', reasoning_effort: 'pro' },
      { request_id: 'ultra', prompt: 'OK', reasoning_effort: 'ultra' },
    ]) {
      const r = await client.callTool({ name: 'chatgpt_ask', arguments: args });
      assert.equal(r.isError, true);
      assert.match((r.content as any[])[0].text, /Input validation error/);
    }
    const invalidReview = await client.callTool({ name: 'review_with_chatgpt', arguments: {
      request_id: 'review-pro', repo_path: dir, scope: 'working_tree', reasoning_effort: 'pro',
    } });
    assert.equal(invalidReview.isError, true);
    assert.match((invalidReview.content as any[])[0].text, /Input validation error/);
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
      ['chatgpt_ask', 'chatgpt_cancel', 'chatgpt_health', 'chatgpt_preview', 'chatgpt_result', 'review_with_chatgpt']);
    const tools = (await client.listTools()).tools;
    for (const name of ['chatgpt_ask', 'review_with_chatgpt']) {
      const schema = tools.find(t => t.name === name)!.inputSchema as any;
      assert.deepEqual(schema.properties.reasoning_effort.enum, ['low', 'medium', 'high', 'xhigh']);
    }
    const preview = await client.callTool({ name: 'chatgpt_preview', arguments: { mode: 'ask', prompt: '안녕하세요' } });
    const metadata = JSON.parse((preview.content as any[])[0].text);
    assert.equal(preview.isError, false);
    assert.equal(metadata.bytes, Buffer.byteLength('안녕하세요'));
    assert.equal(metadata.within_limits, true);
    assert.deepEqual(metadata.files, []);
    const result = await client.callTool({ name: 'chatgpt_health', arguments: {} });
    const text = (result.content as any[])[0].text;
    assert.ok(['connected', 'unavailable'].includes(JSON.parse(text).browser));
    assert.equal(result.isError, false);
    const invalid = await client.callTool({ name: 'chatgpt_ask', arguments: {} });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); }
});

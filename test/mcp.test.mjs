import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { OrderBook } from '../src/orders.mjs';

test('real MCP stdio supports offline orders and reading independently saved results', async () => {
  const home = await mkdtemp('/tmp/cw-mcp-');
  const client = new Client({ name: 'codex-to-agents-test', version: '1.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/command.mjs', import.meta.url)), 'serve', '--home', home], stderr: 'pipe' }));
    assert.equal((await client.listTools()).tools.length, 6);
    assert.equal((await client.callTool({ name: 'runtime_info', arguments: {} })).structuredContent.online, false);
    const task = await client.callTool({ name: 'work_submit', arguments: { goal: 'offline hello' } });
    assert.equal(task.structuredContent.status, 'queued');
    const id = task.structuredContent.order_id;
    const book = new OrderBook(home);await book.transition(id, 'completed', { output: { text: 'verified result' } });
    const result = await client.callTool({ name: 'work_inspect', arguments: { order_id: id } });
    assert.equal(result.structuredContent.output.text, 'verified result');
  } finally { await client.close();await rm(home, { recursive: true, force: true }); }
});

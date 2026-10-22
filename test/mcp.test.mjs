import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join } from 'node:path';
import { OrderBook } from '../src/orders.mjs';
import { stopBackend } from '../src/backend-control.mjs';

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
  } finally { await client.close();await stopBackend(home);await rm(home, { recursive: true, force: true }); }
});

test('real MCP stdio documents order_id generation and rejects malformed IDs before any work is saved', async () => {
  const home = await mkdtemp('/tmp/cw-mcp-id-');
  const client = new Client({ name: 'codex-to-agents-id-test', version: '1.0' });
  const call = async (name, args) => {
    try { return await client.callTool({ name, arguments: args }); }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  };
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/command.mjs', import.meta.url)), 'serve', '--home', home], stderr: 'pipe' }));

    const tools = (await client.listTools()).tools;
    const submit = tools.find(tool => tool.name === 'work_submit');
    const inspect = tools.find(tool => tool.name === 'work_inspect');
    assert.ok(!submit.inputSchema.required.includes('order_id'));
    assert.match(submit.inputSchema.properties.order_id.description, /Omit it and the server generates one/);
    assert.match(submit.inputSchema.properties.order_id.description, /real UUID with a UUID generator \(for example crypto\.randomUUID\(\)\) before the first call/);
    assert.match(submit.inputSchema.properties.order_id.description, /reuse that same UUID with identical arguments/);
    assert.match(submit.inputSchema.properties.order_id.description, /Never use a task title, cw- conversation ID, or example placeholder/);
    assert.match(submit.description, /Omit order_id and the server generates a UUID/);
    assert.match(inspect.inputSchema.properties.order_id.description, /Omit it to list recent work orders/);

    const automatic = (await call('work_submit', { goal: 'generated id' })).structuredContent;
    assert.equal(automatic.reused, false);
    assert.match(automatic.order_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const id = randomUUID();
    const first = (await call('work_submit', { order_id: id, goal: 'retry me' })).structuredContent;
    const retry = (await call('work_submit', { order_id: id, goal: 'retry me' })).structuredContent;
    assert.equal(first.order_id, id);assert.equal(first.reused, false);assert.equal(retry.reused, true);
    const conflict = await call('work_submit', { order_id: id, goal: 'different work' });
    assert.equal(conflict.isError, true);assert.match(conflict.content[0].text, /already bound to different work/);

    for (const invalid of ['my-task', `cw-${id}`, 'not-a-uuid']) {
      const rejected = await call('work_submit', { order_id: invalid, goal: 'must not save' });
      assert.equal(rejected.isError, true);
      assert.match(rejected.content[0].text, /order_id/);
      assert.match(rejected.content[0].text, /must be a real UUID/);
      assert.match(rejected.content[0].text, /Omit order_id/);
      assert.match(rejected.content[0].text, /generate a real UUID/);
    }
    const files = await readdir(join(home, 'requests'));
    assert.equal(files.length, 2);
    assert.deepEqual(files.map(name => name.slice(0, -5)).sort(), [automatic.order_id, id].sort());
    assert.equal((await call('work_inspect', { order_id: 'my-task' })).isError, true);
  } finally { await client.close();await stopBackend(home);await rm(home, { recursive: true, force: true }); }
});

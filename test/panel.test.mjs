import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import vm from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { OrderBook } from '../src/orders.mjs';
import { readDelegation, saveDelegation, delegationContext, runDelegationHook } from '../src/delegation.mjs';
import { preparePlugin } from '../src/plugin.mjs';
import { PANEL_URI } from '../src/panel.mjs';
import { namedNode } from '../src/processes.mjs';
import { stopBackend } from '../src/backend-control.mjs';

const run = (command, args, { input = '', ...options } = {}) => new Promise((resolve, reject) => {
  const child = execFile(command, args, options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
  child.stdin.end(input);
});
const entry = fileURLToPath(new URL('../src/command.mjs', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp('/tmp/cta-panel-');
  t.after(async () => { await stopBackend(root);await rm(root, { recursive: true, force: true }); });
  return root;
}

test('delegation defaults OFF without creating files; ON/OFF only changes preference and hook context', async t => {
  const root = await fixture(t);const home = join(root, 'absent');
  assert.deepEqual(await readDelegation(home), { enabled: false, executor: 'hermes' });
  await assert.rejects(access(home), { code: 'ENOENT' });
  await saveDelegation(home, { enabled: true, executor: 'hermes' });
  const book = new OrderBook(home);
  const task = await book.submit('work_submit', { executor: 'hermes', goal: 'existing task' });
  await book.transition(task.order_id, 'executing', { conversation_id: 'native' });
  assert.match(await delegationContext(home), /executor: "hermes"/);
  await saveDelegation(home, { enabled: false, executor: 'dsh' });
  assert.match(await delegationContext(home), /取代本会话之前/);
  assert.equal((await book.inspect(task.order_id)).status, 'executing');
  assert.equal((await book.list()).length, 1);
  await assert.rejects(saveDelegation(home, { enabled: 'true', executor: 'hermes' }));
  await assert.rejects(saveDelegation(home, { enabled: true, executor: 'other' }));
  assert.equal((await readDelegation(home)).enabled, false);
  await writeFile(join(home, 'delegation.json'), '{corrupt');
  assert.match(await delegationContext(home), /本轮按关闭处理/);
  let output = '';
  await runDelegationHook(home, Readable.from(['{"prompt":"do not leak this"}']), new Writable({ write(chunk, _, done) { output += chunk;done(); } }));
  const hook = JSON.parse(output);
  assert.equal(hook.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(!output.includes('do not leak this'));
});

test('real panel MCP exposes sidebar/resource and app-only settings, persists across connections, and never publishes orders', async t => {
  const home = await fixture(t);
  const connect = async () => {
    const client = new Client({ name: 'panel-test', version: '1.0' });
    await client.connect(new StdioClientTransport({ command: await namedNode(home, 'agents-board'), args: [entry, 'serve', '--panel-only', '--home', home], stderr: 'pipe' }));
    t.after(() => client.close());return client;
  };
  const client = await connect();
  const { tools } = await client.listTools();
  assert.equal(tools.length, 3);
  const opener = tools.find(tool => tool.name === 'open_panel');
  assert.equal(opener._meta.ui.resourceUri, PANEL_URI);
  assert.deepEqual(opener._meta['openai/ui'].entrypoints, [{ type: 'global' }, { type: 'thread' }]);
  assert.deepEqual(tools.find(tool => tool.name === 'panel_settings')._meta.ui.visibility, ['app']);
  assert.equal((await client.listResources()).resources[0].uri, PANEL_URI);
  const { contents } = await client.readResource({ uri: PANEL_URI });
  assert.equal(contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.equal(contents[0]._meta['openai/ui'].preferredDisplayMode, 'fullscreen');
  assert.match(contents[0].text, /ui\/initialize/);assert.match(contents[0].text, /自动派工/);
  assert.ok(!contents[0].text.includes('src="/monitor-client.js"'));
  const call = async (name, args = {}) => (await client.callTool({ name, arguments: args }));
  const initial = (await call('panel_snapshot')).structuredContent;
  assert.equal(initial.delegation.enabled, false);
  assert.equal(initial.service.name, 'agents-backend');
  assert.ok(initial.service.pid > 0);assert.ok(initial.service.rss_mib > 0);
  if (process.platform === 'darwin') {
    const { stdout } = await run('/bin/ps', ['-p', String(initial.service.pid), '-o', 'ucomm=']);
    assert.equal(stdout.trim(), 'agents-backend');
  }
  const changed = await call('panel_settings', { enabled: true, executor: 'dsh' });
  assert.equal(changed.structuredContent.executor, 'dsh');
  const second = await connect();
  assert.equal((await second.callTool({ name: 'panel_snapshot', arguments: {} })).structuredContent.delegation.enabled, true);
  assert.equal((await call('panel_settings', { enabled: true, executor: 'bad' })).isError, true);
  await call('panel_settings', { enabled: false, executor: 'hermes' });
  assert.equal((await new OrderBook(home).list()).length, 0);
  const { stdout } = await run(process.execPath, [entry, 'delegation-hook', '--home', home], { input: '' });
  assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /开关当前为关闭/);
});

test('plugin package points at working runtime and hook quotes task paths safely', async t => {
  const root = await fixture(t);const home = join(root, "a ' $(ignored) dir");
  const plugin = await preparePlugin(home, { root: join(root, 'marketplace') });
  const manifest = JSON.parse(await readFile(join(plugin.plugin, '.codex-plugin/plugin.json')));
  assert.equal(manifest.hooks, './hooks/hooks.json');
  const mcp = JSON.parse(await readFile(join(plugin.plugin, '.mcp.json')));
  assert.ok(mcp.mcpServers.agents_board.url.endsWith('/board'));
  assert.ok(mcp.mcpServers.agents_board.http_headers_helper.includes('backend-headers'));
  const hook = JSON.parse(await readFile(join(plugin.plugin, 'hooks/hooks.json'))).hooks.UserPromptSubmit[0].hooks[0];
  const { stdout } = await run('/bin/sh', ['-c', hook.command], { input: '' });
  assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /当前为关闭/);
  const catalog = JSON.parse(await readFile(join(plugin.root, '.agents/plugins/marketplace.json')));
  assert.equal(catalog.plugins[0].source.path, './plugins/agents-board');
  await assert.rejects(access(join(home, 'delegation.json')), { code: 'ENOENT' });
  await stopBackend(home);
});

test('panel bridge negotiates the official protocol and ignores messages from other frames', async () => {
  const source = await readFile(new URL('../src/panel-bridge.js', import.meta.url), 'utf8');
  const sent = [];let receive;
  const parent = { postMessage(message) { sent.push(message); } };
  const window = { parent, addEventListener(name, callback) { if (name === 'message') receive = callback; } };
  vm.runInNewContext(source, { window, document: { documentElement: { style: {} } }, setTimeout, clearTimeout });
  const init = sent.shift();
  assert.equal(init.method, 'ui/initialize');assert.equal(init.params.appInfo.name, 'codex-to-agents-board');
  receive({ source: parent, data: { jsonrpc: '2.0', id: init.id, result: { protocolVersion: '2026-01-26' } } });
  const request = window.agentsHost.call('panel_snapshot');
  await new Promise(resolve => setImmediate(resolve));
  const tool = sent.find(message => message.method === 'tools/call');
  let resolved = false;request.then(() => { resolved = true; });
  receive({ source: {}, data: { jsonrpc: '2.0', id: tool.id, result: { structuredContent: { injected: true } } } });
  await new Promise(resolve => setImmediate(resolve));assert.equal(resolved, false);
  receive({ source: parent, data: { jsonrpc: '2.0', id: tool.id, result: { structuredContent: { correct: true } } } });
  assert.deepEqual(await request, { correct: true });
  const waiting = window.agentsHost.call('panel_snapshot');
  await new Promise(resolve => setImmediate(resolve));
  receive({ source: parent, data: { jsonrpc: '2.0', id: 90, method: 'ui/resource-teardown' } });
  await assert.rejects(waiting, /已关闭/);
});

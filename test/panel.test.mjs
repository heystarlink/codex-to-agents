import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, access, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import vm from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcp } from '../src/mcp.mjs';
import { OrderBook } from '../src/orders.mjs';
import { readDelegation, saveDelegation, delegationContext, runDelegationHook } from '../src/delegation.mjs';
import { preparePlugin } from '../src/plugin.mjs';
import { PANEL_URI } from '../src/panel.mjs';
import { monitorWeb } from '../src/monitor-web.mjs';
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
  const context = await delegationContext(home);
  assert.match(context, /executor: "hermes"/);
  assert.match(context, /work_submit 的 order_id 可省略并由系统生成/);
  assert.match(context, /crypto\.randomUUID\(\)/);
  assert.match(context, /首次提交与不确定重试沿用同一个 order_id 和完全相同的参数/);
  assert.match(context, /不得把任务名、cw- 会话 ID 或示例占位符当作 order_id/);
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

test('fixed model preferences use executor catalog identities, reject unavailable routes, and can turn OFF while offline', async t => {
  const home = await fixture(t);const book = new OrderBook(home);await book.open();
  const route = { provider: 'account', model: 'shared-id' };
  await book.runtime({ active: true, at: new Date().toISOString(), catalog: { models: [route] } }, 'dsh');
  await saveDelegation(home, { enabled: true, executor: 'dsh', route });
  assert.deepEqual((await readDelegation(home)).route, route);
  assert.match(await delegationContext(home), /executor: "dsh", provider: "account", model: "shared-id"/);
  assert.match(await delegationContext(home), /不可用时说明原因，不静默替换/);
  const before = await readFile(join(home, 'delegation.json'), 'utf8');
  await assert.rejects(saveDelegation(home, { enabled: true, executor: 'dsh', route: { ...route, provider: 'other' } }), /不可用/);
  assert.equal(await readFile(join(home, 'delegation.json'), 'utf8'), before);
  await saveDelegation(home, { enabled: false, executor: 'dsh', route });
  await book.runtime({ active: true, at: new Date().toISOString(), catalog: { models: [route], error: 'catalog failed' } }, 'dsh');
  await assert.rejects(saveDelegation(home, { enabled: true, executor: 'dsh', route }), /目录暂时不可用/);
  await book.runtime({ active: false, at: new Date().toISOString(), catalog: { models: [route] } }, 'dsh');
  await saveDelegation(home, { enabled: false, executor: 'dsh', route });
  assert.deepEqual((await readDelegation(home)).route, route);
  await assert.rejects(saveDelegation(home, { enabled: true, executor: 'dsh', route }), /未连接/);
  assert.equal((await readDelegation(home)).enabled, false);
  await saveDelegation(home, { enabled: true, executor: 'hermes' });
  assert.equal((await readDelegation(home)).route, undefined);
  assert.match(await delegationContext(home), /不沿用本会话之前的固定模型偏好/);
  assert.equal((await book.list()).length, 0);
});

test('panel refresh targets the stored or selected executor and returns without waiting for initialization', { timeout: 3000 }, async t => {
  const home = await fixture(t);await saveDelegation(home, { enabled: false, executor: 'dsh' });
  const refreshed = [];
  let healthChecks = 0;
  const server = await createMcp(home, { panelOnly: true, onPanel: () => { healthChecks++;return new Promise(() => {}); }, onRuntime: executor => {
    refreshed.push(executor);return new Promise(() => {});
  } });
  const client = new Client({ name: 'panel-refresh-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close();await server.close(); });
  await server.connect(a);await client.connect(b);
  const call = args => client.callTool({ name: 'panel_snapshot', arguments: args });
  await call({});assert.deepEqual(refreshed, []);
  assert.equal((await call({ refresh_models: true })).structuredContent.delegation.executor, 'dsh');
  await call({ refresh_models: true, executor: 'hermes' });
  assert.deepEqual(refreshed, ['dsh', 'hermes']);
  assert.equal(healthChecks, 3);
  assert.equal((await new OrderBook(home).list()).length, 0);
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
  assert.equal(tools.length, 4);
  const opener = tools.find(tool => tool.name === 'open_panel');
  assert.equal(opener._meta.ui.resourceUri, PANEL_URI);
  assert.deepEqual(opener._meta['openai/ui'].entrypoints, [{ type: 'global' }, { type: 'thread' }]);
  assert.deepEqual(tools.find(tool => tool.name === 'panel_settings')._meta.ui.visibility, ['app']);
  assert.deepEqual(tools.find(tool => tool.name === 'panel_sdd')._meta.ui.visibility, ['app']);
  assert.equal((await client.listResources()).resources[0].uri, PANEL_URI);
  const { contents } = await client.readResource({ uri: PANEL_URI });
  assert.equal(contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.equal(contents[0]._meta['openai/ui'].preferredDisplayMode, 'fullscreen');
  assert.match(contents[0].text, /ui\/initialize/);assert.match(contents[0].text, /自动派工/);
  assert.match(contents[0].text, /id="delegation-model"/);
  assert.match(contents[0].text, /id="activation-message"/);
  assert.match(contents[0].text, /id="sdd"/);
  assert.match(contents[0].text, /SDD 共享工作区/);
  assert.match(contents[0].text, /SDD文档保存在此工作区。项目用于分类，任务各存一份task.md。/);
  assert.match(contents[0].text, /id="sdd-workspace-path"/);
  assert.match(contents[0].text, /请在 Codex 看板中管理共享任务文档/);
  assert.ok(!contents[0].text.includes('id="sdd-project-path"'), 'the project form must not ask for a code directory');
  for (const id of ['agents', 'orders', 'summary', 'service-info']) assert.ok(!contents[0].text.includes(`id="${id}"`));
  assert.ok(!contents[0].text.includes('src="/monitor-client.js"'));
  assert.ok(!contents[0].text.includes('src="/sdd-client.js"'));
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

test('panel_sdd is app-only, object-schemed, workspace-fenced, revisioned, lazy, and never leaks document bodies into snapshots', async t => {
  const home = await fixture(t);
  const connect = async () => {
    // In-memory MCP keeps this contract test independent of platform process
    // naming; the stdio panel path is covered by the real-panel test above.
    const server = await createMcp(home, { panelOnly: true });
    const client = new Client({ name: 'panel-sdd-test', version: '1.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    t.after(async () => { await client.close();await server.close(); });
    await server.connect(a);await client.connect(b);
    return client;
  };
  const client = await connect();
  const tools = (await client.listTools()).tools;
  const sdd = tools.find(tool => tool.name === 'panel_sdd');
  assert.ok(sdd);
  assert.deepEqual(sdd._meta.ui.visibility, ['app']);
  assert.equal(sdd.annotations.readOnlyHint, false);
  assert.equal(sdd.inputSchema.type, 'object', 'the SDK must publish an object schema');
  assert.ok(sdd.inputSchema.properties.action, 'the action discriminator is visible to clients');
  assert.ok(sdd.inputSchema.properties.workspace_id, 'the workspace fence is part of the discoverable schema');
  assert.deepEqual([...sdd.inputSchema.properties.action.enum].sort(),
    ['create_task', 'get_workspace', 'list_projects', 'list_tasks', 'read_task', 'register_project', 'save_task', 'set_workspace']);
  const call = async (name, args = {}) => client.callTool({ name, arguments: args });

  await call('panel_snapshot');
  await assert.rejects(access(join(home, 'sdd')), { code: 'ENOENT' }, 'snapshots never touch document storage');
  const initial = (await call('panel_sdd', { action: 'get_workspace' })).structuredContent;
  assert.equal(initial.default, true);
  assert.equal(initial.directory, await realpath(join(home, 'sdd')));
  const initialId = initial.workspace_id;
  assert.match(initialId, /^[a-f0-9]{16}$/);
  const listed = (await call('panel_sdd', { action: 'list_projects', workspace_id: initialId })).structuredContent;
  assert.deepEqual(listed.projects, []);
  const registered = (await call('panel_sdd', { action: 'register_project', workspace_id: initialId, name: '共享工程' })).structuredContent;
  const projectId = registered.project.id;
  assert.match(projectId, /^[a-f0-9]{16}$/);
  assert.equal((await call('panel_sdd', { action: 'register_project', workspace_id: initialId, name: '共享工程' })).structuredContent.created, false,
    'the same trimmed name reuses the project classification');
  const tasks = (await call('panel_sdd', { action: 'list_tasks', workspace_id: initialId, project_id: projectId })).structuredContent;
  assert.deepEqual(tasks.tasks, []);
  const created = (await call('panel_sdd', { action: 'create_task', workspace_id: initialId, project_id: projectId, title: '共享文档' })).structuredContent;
  assert.match(created.content, /## 目标/);
  assert.match(created.content, /## 验收条件/);
  const read = (await call('panel_sdd', { action: 'read_task', workspace_id: initialId, project_id: projectId, task_id: created.task.id })).structuredContent;
  const marker = '唯一标记-shared-doc-7f3a';
  const saved = (await call('panel_sdd', {
    action: 'save_task', workspace_id: initialId, project_id: projectId, task_id: created.task.id,
    content: `# 更新\n\n${marker}\n`, revision: read.revision,
  })).structuredContent;
  assert.match(saved.content, new RegExp(marker));
  assert.notEqual(saved.revision, read.revision);

  const snapshot = (await call('panel_snapshot')).structuredContent;
  assert.ok(!JSON.stringify(snapshot).includes(marker), 'snapshot must not include document bodies');
  assert.ok(!('sdd' in snapshot));

  // Reconnecting keeps the persisted workspace identifier and its documents.
  const second = await connect();
  const reopened = (await second.callTool({ name: 'panel_sdd', arguments: { action: 'get_workspace' } })).structuredContent;
  assert.equal(reopened.workspace_id, initialId);
  const reread = (await second.callTool({ name: 'panel_sdd', arguments: {
    action: 'read_task', workspace_id: initialId, project_id: projectId, task_id: created.task.id,
  } })).structuredContent;
  assert.match(reread.content, new RegExp(marker));

  const stale = await call('panel_sdd', {
    action: 'save_task', workspace_id: initialId, project_id: projectId, task_id: created.task.id,
    content: '# 覆盖\n', revision: read.revision,
  });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /重新读取|冲突/);

  // Switching the shared workspace moves the document set; a board still
  // holding the previous identifier is rejected instead of writing there.
  const nextRoot = join(home, 'workspace-docs');
  const switched = (await call('panel_sdd', { action: 'set_workspace', directory: nextRoot })).structuredContent;
  assert.equal(switched.directory, await realpath(nextRoot));
  assert.equal(switched.changed, true);
  assert.notEqual(switched.workspace_id, initialId);
  assert.deepEqual(JSON.parse(await readFile(join(home, 'sdd-workspace.json'), 'utf8')), { directory: await realpath(nextRoot) });
  assert.deepEqual((await call('panel_sdd', { action: 'list_projects', workspace_id: switched.workspace_id })).structuredContent.projects, []);
  const fenced = await call('panel_sdd', {
    action: 'save_task', workspace_id: initialId, project_id: projectId, task_id: created.task.id,
    content: '# 旧看板草稿\n', revision: saved.revision,
  });
  assert.equal(fenced.isError, true);
  assert.match(fenced.content[0].text, /工作区已切换|重新读取工作区/);
  // Switching back restores the old identifier and its untouched documents.
  const restored = (await call('panel_sdd', { action: 'set_workspace', directory: join(home, 'sdd') })).structuredContent;
  assert.equal(restored.workspace_id, initialId);
  assert.match((await call('panel_sdd', {
    action: 'read_task', workspace_id: initialId, project_id: projectId, task_id: created.task.id,
  })).structuredContent.content, new RegExp(marker));

  for (const args of [
    { action: 'read_task', workspace_id: initialId, project_id: projectId },
    { action: 'list_tasks', workspace_id: initialId, project_id: '../escape' },
    { action: 'register_project', workspace_id: initialId, name: '工程', directory: '/code/path' },
    { action: 'register_project', workspace_id: initialId, name: '' },
    { action: 'set_workspace', workspace_id: initialId, directory: join(home, 'elsewhere') },
    { action: 'set_workspace', directory: 'relative/path' },
    { action: 'save_task', workspace_id: initialId, project_id: projectId, task_id: created.task.id, content: 'x', revision: 'bad' },
    { action: 'delete_everything' },
  ]) assert.equal((await call('panel_sdd', args)).isError, true, JSON.stringify(args));

  const normal = await createMcp(home);
  const normalClient = new Client({ name: 'normal-tools', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await normalClient.close();await normal.close(); });
  await normal.connect(a);await normalClient.connect(b);
  const names = (await normalClient.listTools()).tools.map(tool => tool.name);
  assert.ok(!names.includes('panel_sdd'), 'documents are app-only, not a model-visible tool');
  assert.ok(!names.includes('open_panel'));

  const source = await readFile(new URL('../src/panel.mjs', import.meta.url), 'utf8');
  assert.match(source, /await import\('\.\/sdd-workspace\.mjs'\)/);
  assert.ok(!/^import[^\n]*sdd-workspace/m.test(source), 'storage stays lazy');
  assert.equal((await new OrderBook(home).list()).length, 0, 'document actions never create work orders');
});

// Old board pages send document actions with a code directory and no
// workspace_id. The server must answer with one readable Chinese hint instead
// of raw Zod issues, and must not touch storage or create work orders.
const LEGACY_MESSAGE = '看板页面版本过旧，缺少工作区标识，无法执行文档操作。请关闭看板页面并重新打开以载入新版本。';
async function openPanelClient(t, home) {
  const server = await createMcp(home, { panelOnly: true });
  const client = new Client({ name: 'panel-inmemory-test', version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close();await server.close(); });
  await server.connect(a);await client.connect(b);
  return client;
}

test('legacy board document actions without workspace_id are rejected with Chinese version guidance and write nothing', async t => {
  const home = await fixture(t);
  const client = await openPanelClient(t, home);
  const call = (args = {}) => client.callTool({ name: 'panel_sdd', arguments: args });
  const legacy = await call({ action: 'register_project', name: '旧看板项目', directory: '/code/path' });
  assert.equal(legacy.isError, true);
  assert.equal(legacy.content[0].text, LEGACY_MESSAGE);
  assert.match(legacy.content[0].text, /版本过旧/);
  assert.match(legacy.content[0].text, /关闭/);
  assert.match(legacy.content[0].text, /重新打开/);
  assert.ok(!/invalid_type|unrecognized_keys|expected/i.test(legacy.content[0].text), 'no raw schema details');
  for (const args of [
    { action: 'list_projects' },
    { action: 'list_tasks', project_id: '0'.repeat(16) },
    { action: 'create_task', project_id: '0'.repeat(16), title: '旧任务' },
    { action: 'read_task', project_id: '0'.repeat(16), task_id: '00000000-0000-4000-8000-000000000000' },
    {
      action: 'save_task', project_id: '0'.repeat(16), task_id: '00000000-0000-4000-8000-000000000000',
      content: '# 旧草稿\n', revision: 'a'.repeat(64),
    },
  ]) {
    const rejected = await call(args);
    assert.equal(rejected.isError, true, JSON.stringify(args));
    assert.equal(rejected.content[0].text, LEGACY_MESSAGE, JSON.stringify(args));
  }
  await assert.rejects(access(join(home, 'sdd')), { code: 'ENOENT' }, 'a rejected legacy request must not create the document workspace');
  assert.equal((await new OrderBook(home).list()).length, 0, 'document actions never create work orders');
});

test('legacy board read/save cannot touch an existing task.md created through the new panel_sdd contract', async t => {
  const home = await fixture(t);
  const client = await openPanelClient(t, home);
  const call = (args = {}) => client.callTool({ name: 'panel_sdd', arguments: args });
  const workspace = (await call({ action: 'get_workspace' })).structuredContent;
  const project = (await call({ action: 'register_project', workspace_id: workspace.workspace_id, name: '合作工程' })).structuredContent.project;
  const created = (await call({ action: 'create_task', workspace_id: workspace.workspace_id, project_id: project.id, title: '共享任务' })).structuredContent;
  const read = (await call({
    action: 'read_task', workspace_id: workspace.workspace_id, project_id: project.id, task_id: created.task.id,
  })).structuredContent;
  const bytesBefore = await readFile(read.path);
  const legacyRead = await call({ action: 'read_task', project_id: project.id, task_id: created.task.id });
  assert.equal(legacyRead.isError, true);
  assert.equal(legacyRead.content[0].text, LEGACY_MESSAGE);
  const legacySave = await call({
    action: 'save_task', project_id: project.id, task_id: created.task.id,
    content: '# 旧看板覆盖\n', revision: read.revision,
  });
  assert.equal(legacySave.isError, true);
  assert.equal(legacySave.content[0].text, LEGACY_MESSAGE);
  assert.deepEqual(await readFile(read.path), bytesBefore, 'a rejected legacy save must not rewrite task.md');
  const reread = (await call({
    action: 'read_task', workspace_id: workspace.workspace_id, project_id: project.id, task_id: created.task.id,
  })).structuredContent;
  assert.equal(reread.content, read.content);
  assert.equal(reread.revision, read.revision);
  assert.equal((await new OrderBook(home).list()).length, 0);
});

test('panel_sdd new workspace contract still works end to end', async t => {
  const home = await fixture(t);
  const client = await openPanelClient(t, home);
  const call = (args = {}) => client.callTool({ name: 'panel_sdd', arguments: args });
  const workspace = (await call({ action: 'get_workspace' })).structuredContent;
  assert.match(workspace.workspace_id, /^[a-f0-9]{16}$/);
  assert.deepEqual((await call({ action: 'list_projects', workspace_id: workspace.workspace_id })).structuredContent.projects, []);
  const registered = (await call({ action: 'register_project', workspace_id: workspace.workspace_id, name: '新契约工程' })).structuredContent;
  assert.equal(registered.created, true);
  assert.deepEqual((await call({ action: 'list_tasks', workspace_id: workspace.workspace_id, project_id: registered.project.id })).structuredContent.tasks, []);
  const created = (await call({ action: 'create_task', workspace_id: workspace.workspace_id, project_id: registered.project.id, title: '新契约任务' })).structuredContent;
  assert.match(created.content, /## 目标/);
  const read = (await call({
    action: 'read_task', workspace_id: workspace.workspace_id, project_id: registered.project.id, task_id: created.task.id,
  })).structuredContent;
  assert.equal(read.content, created.content);
  const saved = (await call({
    action: 'save_task', workspace_id: workspace.workspace_id, project_id: registered.project.id, task_id: created.task.id,
    content: '# 新契约任务\n\n已更新。\n', revision: read.revision,
  })).structuredContent;
  assert.match(saved.content, /已更新/);
  assert.notEqual(saved.revision, read.revision);
  assert.equal((await new OrderBook(home).list()).length, 0);
});

test('board/v2 is the only panel resource and every board metadata reference points at it', async t => {
  const home = await fixture(t);
  const client = await openPanelClient(t, home);
  const legacyUri = ['ui://codex-to-agents/board', 'v1'].join('/');
  const resources = (await client.listResources()).resources;
  assert.equal(resources.length, 1, 'exactly one canonical board resource');
  assert.equal(resources[0].uri, PANEL_URI);
  assert.ok(PANEL_URI.endsWith('/v2'));
  assert.ok(!resources.some(resource => resource.uri === legacyUri), 'no v1 compatibility alias is listed');
  const tools = (await client.listTools()).tools;
  assert.equal(tools.find(tool => tool.name === 'open_panel')._meta.ui.resourceUri, PANEL_URI);
  for (const name of ['panel_snapshot', 'panel_settings', 'panel_sdd']) {
    assert.equal(tools.find(tool => tool.name === name)._meta.ui.resourceUri, PANEL_URI, name);
  }
  const { contents } = await client.readResource({ uri: PANEL_URI });
  assert.equal(contents.length, 1);
  assert.equal(contents[0].uri, PANEL_URI);
  const html = contents[0].text;
  assert.match(html, /id="sdd"/);
  assert.match(html, /SDD 共享工作区/);
  assert.match(html, /id="sdd-workspace-path"/);
  assert.ok(!html.includes('id="sdd-project-path"'), 'the board form must not ask for a code directory');
  assert.ok(!html.includes(legacyUri), 'the served board page must not mention the old resource URI');
  const source = await readFile(new URL('../src/panel.mjs', import.meta.url), 'utf8');
  assert.ok(!source.includes(legacyUri), 'no old board URI literal remains in src/panel.mjs');
  assert.match(source, /board\/v2/);
});

test('read-only HTTP monitor serves the shared-doc shell but still rejects writes', async t => {
  const home = await fixture(t);
  const dashboard = await monitorWeb(home, { port: 0 });
  t.after(() => dashboard.close());
  const page = await fetch(dashboard.url + '/');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /id="sdd"/);
  assert.match(html, /SDD 共享工作区/);
  assert.match(html, /SDD文档保存在此工作区。项目用于分类，任务各存一份task.md。/);
  assert.match(html, /id="sdd-workspace-path"/);
  assert.ok(!html.includes('sdd-project-path'), 'the read-only shell asks for no code directory either');
  assert.match(html, /src="\/sdd-client\.js"/);
  const script = await fetch(dashboard.url + '/sdd-client.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /text\/javascript/);
  const source = await script.text();
  assert.match(source, /panel_sdd/);
  assert.match(source, /请在 Codex 看板中管理共享任务文档/);
  const write = await fetch(dashboard.url + '/api/snapshot', { method: 'POST' });
  assert.equal(write.status, 405);
  assert.equal(await write.text(), 'Read-only monitor.');
});

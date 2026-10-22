import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { join } from 'node:path';
import { OrderBook } from '../src/orders.mjs';
import { createMcp } from '../src/mcp.mjs';
import { stopBackend } from '../src/backend-control.mjs';

const NORMAL_TOOLS = ['conversation_control', 'runtime_info', 'sdd_task', 'work_inspect', 'work_submit', 'work_update', 'workspace_control'];
const PLAN = '# 模型完整规划\n\n## 目标\n\n把规划保存到共享文档。\n\n## 范围\n\n只写 SDD 文档，不改代码。\n\n## 计划\n\n1. 读取工作区\n2. 创建任务文档\n\n## 验收条件\n\n- [ ] task.md 与规划一致\n';

test('real MCP stdio exposes exactly seven tools, saves a complete model plan, and supports offline orders', async () => {
  const home = await mkdtemp('/tmp/cw-mcp-');
  const client = new Client({ name: 'codex-to-agents-test', version: '1.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/command.mjs', import.meta.url)), 'serve', '--home', home], stderr: 'pipe' }));
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 7);
    assert.deepEqual(tools.map(tool => tool.name).sort(), NORMAL_TOOLS, 'the model catalog is exactly the six dispatch/inspection tools plus sdd_task');
    assert.equal((await client.callTool({ name: 'runtime_info', arguments: {} })).structuredContent.online, false);
    const workspace = (await client.callTool({ name: 'sdd_task', arguments: { action: 'get_workspace' } })).structuredContent;
    const project = (await client.callTool({ name: 'sdd_task', arguments: {
      action: 'register_project', workspace_id: workspace.workspace_id, name: 'stdio 模型工程',
    } })).structuredContent.project;
    const created = (await client.callTool({ name: 'sdd_task', arguments: {
      action: 'create_task', workspace_id: workspace.workspace_id, project_id: project.id, content: PLAN,
    } })).structuredContent;
    assert.equal(created.content, PLAN);
    assert.equal(await readFile(created.path, 'utf8'), PLAN);
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

test('model sdd_task is object-schemed, cannot choose the workspace root, writes complete plans only, and submits no work', async () => {
  const home = await mkdtemp('/tmp/cw-mcp-sdd-');
  const server = await createMcp(home);
  const client = new Client({ name: 'model-sdd-test', version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);await client.connect(b);
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map(tool => tool.name).sort(), NORMAL_TOOLS);
    const sdd = tools.find(tool => tool.name === 'sdd_task');
    assert.ok(sdd);
    assert.equal(sdd.inputSchema.type, 'object', 'the SDK must publish an object root');
    assert.equal(sdd.inputSchema.additionalProperties, false);
    assert.deepEqual([...sdd.inputSchema.properties.action.enum].sort(),
      ['create_task', 'get_workspace', 'list_projects', 'list_tasks', 'read_task', 'register_project', 'save_task']);
    assert.equal(sdd.inputSchema.properties.directory, undefined, 'the model cannot select or change the document root');
    assert.equal(sdd.inputSchema.properties.root, undefined);
    assert.equal(sdd._meta?.ui, undefined, 'the model tool is not an app-only board tool');
    assert.equal(sdd.annotations.readOnlyHint, false);
    assert.match(sdd.description, /cannot choose or change the document root/);

    const call = (name, args = {}) => client.callTool({ name, arguments: args });
    const workspace = (await call('sdd_task', { action: 'get_workspace' })).structuredContent;
    assert.match(workspace.workspace_id, /^[a-f0-9]{16}$/);
    const registered = (await call('sdd_task', { action: 'register_project', workspace_id: workspace.workspace_id, name: '模型工程' })).structuredContent;
    const projectDirectory = registered.project.path;
    const taskDirectories = async () => (await readdir(projectDirectory)).filter(name => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name));
    const before = (await taskDirectories()).length;

    const created = (await call('sdd_task', { action: 'create_task', workspace_id: workspace.workspace_id, project_id: registered.project.id, content: PLAN })).structuredContent;
    assert.equal(created.content, PLAN);
    assert.equal(created.task.title, '模型完整规划');
    assert.equal(created.path, created.task.path);
    assert.ok(created.path.startsWith('/'), 'the response carries an absolute document path for the work order');
    assert.equal(await readFile(created.path, 'utf8'), PLAN);
    assert.doesNotMatch(created.content, /待填写/);
    assert.deepEqual(await readdir(join(projectDirectory, created.task.id)), ['task.md']);
    assert.equal((await taskDirectories()).length, before + 1);

    const read = (await call('sdd_task', { action: 'read_task', workspace_id: workspace.workspace_id, project_id: registered.project.id, task_id: created.task.id })).structuredContent;
    assert.equal(read.content, PLAN);
    assert.equal(read.revision, created.revision);
    const listed = (await call('sdd_task', { action: 'list_tasks', workspace_id: workspace.workspace_id, project_id: registered.project.id })).structuredContent;
    assert.equal(listed.tasks.length, before + 1);
    assert.ok(listed.tasks.some(task => task.id === created.task.id && task.path === created.path));

    const rejectedCreates = [
      { action: 'create_task', workspace_id: workspace.workspace_id, project_id: registered.project.id, title: '只有模板标题' },
      { action: 'create_task', workspace_id: workspace.workspace_id, project_id: registered.project.id, content: '  \n\t ' },
      { action: 'create_task', workspace_id: workspace.workspace_id, project_id: registered.project.id, content: 'x'.repeat(256 * 1024 + 1) },
      { action: 'create_task', workspace_id: workspace.workspace_id, project_id: 'f'.repeat(16), content: PLAN },
    ];
    for (const args of rejectedCreates) {
      const rejected = await call('sdd_task', args);
      assert.equal(rejected.isError, true, JSON.stringify(args).slice(0, 120));
    }
    assert.equal((await taskDirectories()).length, before + 1, 'rejected create_task calls leave no task folder');

    for (const args of [
      { action: 'set_workspace', directory: join(home, 'elsewhere') },
      { action: 'list_projects', workspace_id: workspace.workspace_id, directory: join(home, 'elsewhere') },
      { action: 'register_project', workspace_id: workspace.workspace_id, name: '工程', root: join(home, 'elsewhere') },
      { action: 'save_task', workspace_id: workspace.workspace_id, project_id: registered.project.id, task_id: created.task.id, content: '# x\n', revision: created.revision, directory: join(home, 'elsewhere') },
    ]) assert.equal((await call('sdd_task', args)).isError, true, JSON.stringify(args));

    const fenced = await call('sdd_task', { action: 'list_projects', workspace_id: '0'.repeat(16) });
    assert.equal(fenced.isError, true);
    assert.match(fenced.content[0].text, /工作区|重新读取/);

    const book = new OrderBook(home);await book.open();
    assert.deepEqual(await book.list(), [], 'document actions never create work orders');
  } finally {
    await client.close();await server.close();await rm(home, { recursive: true, force: true });
  }
});

test('cross-surface MCP: model save, panel read/edit, stale model revision rejection, and a real workspace switch fence', async () => {
  const home = await mkdtemp('/tmp/cw-mcp-cross-');
  const connections = [];
  const connect = async options => {
    const server = await createMcp(home, options);
    const client = new Client({ name: 'cross-surface-test', version: '1.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);await client.connect(b);
    connections.push({ client, server });
    return client;
  };
  try {
    const model = await connect();
    const panel = await connect({ panelOnly: true });
    const call = (client, name, args = {}) => client.callTool({ name, arguments: args });
    const modelCall = args => call(model, 'sdd_task', args);
    const panelCall = args => call(panel, 'panel_sdd', args);

    const workspace = (await modelCall({ action: 'get_workspace' })).structuredContent;
    const workspaceId = workspace.workspace_id;
    const project = (await modelCall({
      action: 'register_project', workspace_id: workspaceId, name: '交叉 MCP 工程',
    })).structuredContent.project;
    const plan = '# 交叉规划\n\n## 目标\n\n模型保存、看板读取。\n\n## 范围\n\n仅文档。\n\n## 计划\n\n1. 保存\n\n## 验收条件\n\n- [ ] 看板读取同一文件\n';
    const created = (await modelCall({
      action: 'create_task', workspace_id: workspaceId, project_id: project.id, content: plan,
    })).structuredContent;
    assert.equal(await readFile(created.path, 'utf8'), plan);

    // The board reads the exact task the model saved from the same workspace.
    const panelWorkspace = (await panelCall({ action: 'get_workspace' })).structuredContent;
    assert.equal(panelWorkspace.workspace_id, workspaceId);
    const panelTasks = (await panelCall({ action: 'list_tasks', workspace_id: workspaceId, project_id: project.id })).structuredContent.tasks;
    assert.equal(panelTasks.length, 1);
    assert.equal(panelTasks[0].id, created.task.id);
    const panelRead = (await panelCall({
      action: 'read_task', workspace_id: workspaceId, project_id: project.id, task_id: created.task.id,
    })).structuredContent;
    assert.equal(panelRead.path, created.path);
    assert.equal(panelRead.content, plan);

    // The board edits the same file; the model's old revision must be rejected.
    const marker = 'cross-board-edit-9c2';
    const panelSaved = (await panelCall({
      action: 'save_task', workspace_id: workspaceId, project_id: project.id, task_id: created.task.id,
      content: `# 看板交叉修改\n\n${marker}\n`, revision: panelRead.revision,
    })).structuredContent;
    assert.match(panelSaved.content, new RegExp(marker));
    const stale = await modelCall({
      action: 'save_task', workspace_id: workspaceId, project_id: project.id, task_id: created.task.id,
      content: '# 模型旧版本\n', revision: created.revision,
    });
    assert.equal(stale.isError, true);
    assert.match(stale.content[0].text, /重新读取|冲突/);
    assert.equal(await readFile(created.path, 'utf8'), panelSaved.content, 'a stale model save must not overwrite the board edit');

    // After re-reading, the model edits the same task and the board sees it.
    const reread = (await modelCall({
      action: 'read_task', workspace_id: workspaceId, project_id: project.id, task_id: created.task.id,
    })).structuredContent;
    assert.equal(reread.revision, panelSaved.revision);
    const modelSaved = (await modelCall({
      action: 'save_task', workspace_id: workspaceId, project_id: project.id, task_id: created.task.id,
      content: `# 模型再次更新\n\n${marker}-model\n`, revision: reread.revision,
    })).structuredContent;
    const panelReread = (await panelCall({
      action: 'read_task', workspace_id: workspaceId, project_id: project.id, task_id: created.task.id,
    })).structuredContent;
    assert.equal(panelReread.revision, modelSaved.revision);
    assert.match(panelReread.content, new RegExp(`${marker}-model`));

    // Switch the real root through the board, then use the old identifier from
    // the model side. The rejection comes from the actual re-read root, not a
    // forged workspace_id.
    const nextRoot = join(home, 'cross-switch-docs');
    const switched = (await panelCall({ action: 'set_workspace', directory: nextRoot })).structuredContent;
    assert.equal(switched.changed, true);
    assert.notEqual(switched.workspace_id, workspaceId);
    assert.deepEqual((await panelCall({ action: 'list_projects', workspace_id: switched.workspace_id })).structuredContent.projects, []);
    const fenced = await modelCall({
      action: 'save_task', workspace_id: workspaceId, project_id: project.id, task_id: created.task.id,
      content: '# 旧工作区覆盖\n', revision: modelSaved.revision,
    });
    assert.equal(fenced.isError, true);
    assert.match(fenced.content[0].text, /工作区已切换|重新读取工作区/);
    assert.equal(await readFile(created.path, 'utf8'), modelSaved.content, 'the old workspace file must stay untouched');
    const fencedList = await modelCall({ action: 'list_tasks', workspace_id: workspaceId, project_id: project.id });
    assert.equal(fencedList.isError, true);
    const fencedRead = await modelCall({ action: 'read_task', workspace_id: workspaceId, project_id: project.id, task_id: created.task.id });
    assert.equal(fencedRead.isError, true);

    const book = new OrderBook(home);await book.open();
    assert.deepEqual(await book.list(), [], 'cross-surface document actions never create work orders');
  } finally {
    for (const { client, server } of connections.reverse()) {
      await client.close();await server.close();
    }
    await rm(home, { recursive: true, force: true });
  }
});

test('model sdd_task cannot flip the SDD switch and its writes are rejected while the board has it OFF', async () => {
  const home = await mkdtemp('/tmp/cw-mcp-switch-');
  const connections = [];
  const connect = async options => {
    const server = await createMcp(home, options);
    const client = new Client({ name: 'model-switch-test', version: '1.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);await client.connect(b);
    connections.push({ client, server });
    return client;
  };
  try {
    const model = await connect();
    const panel = await connect({ panelOnly: true });
    const call = (client, name, args = {}) => client.callTool({ name, arguments: args });
    const modelCall = args => call(model, 'sdd_task', args);
    const panelCall = args => call(panel, 'panel_sdd', args);

    const workspace = (await modelCall({ action: 'get_workspace' })).structuredContent;
    assert.equal(workspace.enabled, true, 'the legacy default is ON');
    await assert.rejects(access(join(home, 'sdd')), { code: 'ENOENT' }, 'reading the switch creates no document root');
    const project = (await modelCall({
      action: 'register_project', workspace_id: workspace.workspace_id, name: '开关模型工程',
    })).structuredContent.project;
    const plan = '# 开关规划\n\n## 目标\n\n关闭后拒绝写入。\n';
    const created = (await modelCall({
      action: 'create_task', workspace_id: workspace.workspace_id, project_id: project.id, content: plan,
    })).structuredContent;

    // The board turns SDD off. The model learns the new state through
    // get_workspace but cannot change it: the action and field do not exist.
    const off = (await panelCall({ action: 'set_enabled', enabled: false })).structuredContent;
    assert.equal(off.enabled, false);
    assert.equal((await modelCall({ action: 'get_workspace' })).structuredContent.enabled, false);
    assert.equal((await modelCall({ action: 'set_enabled', enabled: true })).isError, true);
    assert.equal((await modelCall({ action: 'get_workspace', enabled: true })).isError, true);
    const tools = (await model.listTools()).tools;
    const tool = tools.find(entry => entry.name === 'sdd_task');
    assert.ok(!tool.inputSchema.properties.action.enum.includes('set_enabled'), 'the model cannot set the switch');
    assert.equal(tool.inputSchema.properties.enabled, undefined);
    assert.match(tool.description, /cannot choose or change the document root or the SDD switch/);

    // Every write is rejected; the existing file is untouched and no task
    // folder is added.
    const taskDirectories = (await readdir(project.path))
      .filter(name => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name));
    const rejectedWrites = [
      { action: 'register_project', workspace_id: workspace.workspace_id, name: '关闭后工程' },
      { action: 'create_task', workspace_id: workspace.workspace_id, project_id: project.id, content: '# 关闭后\n' },
      {
        action: 'save_task', workspace_id: workspace.workspace_id, project_id: project.id, task_id: created.task.id,
        content: '# 关闭后覆盖\n', revision: created.revision,
      },
    ];
    for (const args of rejectedWrites) {
      const rejected = await modelCall(args);
      assert.equal(rejected.isError, true, JSON.stringify(args));
      assert.match(rejected.content[0].text, /SDD 任务文档已关闭|已关闭/);
    }
    assert.equal(await readFile(created.path, 'utf8'), plan, 'the disabled switch leaves the document untouched');
    assert.deepEqual((await readdir(project.path))
      .filter(name => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name)), taskDirectories);
    assert.equal((await modelCall({
      action: 'read_task', workspace_id: workspace.workspace_id, project_id: project.id, task_id: created.task.id,
    })).structuredContent.content, plan, 'reads stay available while OFF');

    // Turning it back on from the board restores writes; the switch setting does
    // not change the root.
    const on = (await panelCall({ action: 'set_enabled', enabled: true })).structuredContent;
    assert.equal(on.enabled, true);
    assert.equal(on.workspace_id, workspace.workspace_id);
    const updated = (await modelCall({
      action: 'save_task', workspace_id: workspace.workspace_id, project_id: project.id, task_id: created.task.id,
      content: '# 重新开启\n', revision: created.revision,
    })).structuredContent;
    assert.equal(await readFile(created.path, 'utf8'), updated.content);

    const book = new OrderBook(home);await book.open();
    assert.deepEqual(await book.list(), [], 'switching SDD never creates work orders');
  } finally {
    for (const { client, server } of connections.reverse()) {
      await client.close();await server.close();
    }
    await rm(home, { recursive: true, force: true });
  }
});

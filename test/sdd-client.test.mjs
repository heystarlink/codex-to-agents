import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const SOURCE = await readFile(new URL('../src/sdd-client.js', import.meta.url), 'utf8');
const HTML = await readFile(new URL('../src/monitor.html', import.meta.url), 'utf8');
const IDS = ['sdd', 'sdd-switch', 'sdd-state', 'sdd-setting-message', 'sdd-summary-meta',
  'sdd-note', 'sdd-workspace-current', 'sdd-workspace-path', 'sdd-workspace-apply',
  'sdd-project', 'sdd-task', 'sdd-project-name', 'sdd-project-add', 'sdd-task-title', 'sdd-task-add',
  'sdd-content', 'sdd-path', 'sdd-copy', 'sdd-save', 'sdd-reload', 'sdd-dirty', 'sdd-guard',
  'sdd-guard-text', 'sdd-guard-keep', 'sdd-guard-discard', 'sdd-message'];
const tick = async (rounds = 5) => {
  for (let index = 0; index < rounds; index++) await new Promise(resolve => setImmediate(resolve));
};

class Element {
  constructor(id) {
    this.id = id;this.value = '';this.textContent = '';this.className = '';this.title = '';
    this.disabled = false;this.hidden = false;this.open = false;this.children = [];this.listeners = new Map();
  }
  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);this.listeners.set(type, list);
  }
  dispatch(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler({ target: this, ...event });
  }
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
}

function environment(input) {
  const nodes = new Map(IDS.map(id => [id, new Element(id)]));
  const document = {
    readyState: 'complete', addEventListener() {},
    getElementById: id => nodes.get(id) ?? null,
    createElement: tag => new Element(tag),
  };
  const window = { agentsHost: input };
  vm.runInNewContext(SOURCE, { window, document, navigator: { clipboard: { writeText: async () => {} } }, console, setTimeout, clearTimeout });
  return { nodes, $: id => nodes.get(id) };
}

function makeHost(handlers) {
  return {
    calls: [], handlers,
    async call(name, args = {}) {
      this.calls.push({ name, args });
      const handler = this.handlers[args.action];
      if (!handler) throw new Error('unexpected action: ' + args.action + ' ' + name);
      return typeof handler === 'function' ? handler(args) : handler;
    },
  };
}

const WS = '1111111111111111';
const WS_OTHER = '2222222222222222';
const project = { id: 'aaaaaaaaaaaaaaaa', name: '工程', path: '/home/sdd/aaaaaaaaaaaaaaaa' };
const otherProject = { id: 'bbbbbbbbbbbbbbbb', name: '另一个工程', path: '/home/sdd/bbbbbbbbbbbbbbbb' };
const revision = 'a'.repeat(64);
const task = { id: '11111111-1111-4111-8111-111111111111', title: '任务一', path: '/home/sdd/a/task.md', revision };
const secondTask = { id: '22222222-2222-4222-8222-222222222222', title: '任务二', path: '/home/sdd/b/task.md', revision };
const documentBody = '# 任务一\n\n## 目标\n\n待填写\n';
const workspaceView = { directory: '/home/sdd', workspace_id: WS, default: true, configured: false, enabled: true };
const switchedWorkspace = { directory: '/new/sdd-docs', workspace_id: WS_OTHER, default: false, configured: true, enabled: true, changed: true };
const docCalls = host => host.calls.filter(call => !['get_workspace', 'set_workspace', 'set_enabled'].includes(call.args.action));

function handlers(overrides = {}) {
  return {
    get_workspace: workspaceView,
    set_workspace: args => ({ ...switchedWorkspace, directory: args.directory }),
    set_enabled: args => ({ ...workspaceView, enabled: args.enabled, changed: true }),
    list_projects: { projects: [project] },
    list_tasks: args => ({ project, tasks: args.project_id === project.id ? [task, secondTask] : [] }),
    read_task: args => ({
      project, task: args.task_id === secondTask.id ? secondTask : task,
      content: args.task_id === secondTask.id ? '# 任务二\n' : documentBody, revision, path: task.path,
    }),
    save_task: args => ({ project, task: { ...task, title: '任务一' }, content: args.content, revision: 'b'.repeat(64), path: task.path }),
    register_project: args => ({ project: { id: 'cccccccccccccccc', name: args.name, path: '/home/sdd/cccccccccccccccc' }, created: true }),
    create_task: args => ({ project, task: { id: '33333333-3333-4333-8333-333333333333', title: args.title, path: '/home/sdd/new/task.md' }, content: '# 新任务\n', revision: 'c'.repeat(64), path: '/home/sdd/new/task.md' }),
    ...overrides,
  };
}

async function open(env) {
  env.$('sdd').open = true;
  env.$('sdd').dispatch('toggle');
  await tick();
}

async function loadTask(env, id = task.id) {
  await open(env);
  env.$('sdd-task').value = id;
  env.$('sdd-task').dispatch('change');
  await tick();
}

function draft(env, text = '# 草稿修改\n') {
  env.$('sdd-content').value = text;
  env.$('sdd-content').dispatch('input');
  return text;
}

test('the SDD switch loads on start, and the section stays lazy and shows only project names', async () => {
  const host = makeHost(handlers({ list_projects: { projects: [project, otherProject] } }));
  const env = environment(host);
  await tick();
  assert.equal(env.$('sdd').open, false, 'the section is still collapsed');
  assert.deepEqual(host.calls.map(call => call.args.action), ['get_workspace'],
    'only the always-visible switch state is read before the section opens');
  assert.equal(env.$('sdd-switch').checked, true);
  assert.equal(env.$('sdd-switch').disabled, false);
  assert.equal(env.$('sdd-state').textContent, '已开启');
  assert.equal(env.$('sdd-summary-meta').textContent, '共享规划与验收约定');
  await open(env);
  assert.deepEqual(host.calls.slice(0, 3).map(call => call.args.action), ['get_workspace', 'get_workspace', 'list_projects']);
  assert.ok(host.calls.some(call => call.args.action === 'list_tasks'));
  assert.ok(!host.calls.some(call => call.args.action === 'read_task'), 'opening the section must not read a document');
  assert.equal(env.$('sdd-workspace-current').textContent, '/home/sdd', 'the actual document directory is shown');
  assert.deepEqual(env.$('sdd-project').children.slice(1).map(option => option.textContent), ['工程', '另一个工程'],
    'projects display their names only, never a path');
  assert.ok(!env.$('sdd-project').children.slice(1).some(option => /\/home\/sdd|aaaaaaaa/.test(option.textContent)));
  assert.equal(env.$('sdd-content').value, '');
  assert.ok(env.$('sdd-message').textContent.length > 0);
  for (const call of docCalls(host)) assert.equal(call.args.workspace_id, WS, 'document calls carry the workspace identifier');
  assert.equal(host.calls[0].args.workspace_id, undefined, 'workspace actions do not carry a stale identifier');
});

test('unsaved drafts guard project/task switching, closing, and new project/task creation', async () => {
  const host = makeHost(handlers());
  const env = environment(host);
  await loadTask(env);
  assert.equal(env.$('sdd-content').value, documentBody);
  const changed = draft(env);
  assert.equal(env.$('sdd-dirty').hidden, false);

  // Project switch: blocked until the user chooses keep or discard.
  const before = host.calls.length;
  env.$('sdd-project').value = otherProject.id;
  env.$('sdd-project').dispatch('change');
  await tick(2);
  assert.equal(host.calls.length, before, 'a guarded switch must not load another project');
  assert.equal(env.$('sdd-guard').hidden, false);
  assert.match(env.$('sdd-guard-text').textContent, /切换项目/);
  assert.equal(env.$('sdd-project').value, project.id);
  assert.equal(env.$('sdd-content').value, changed);
  env.$('sdd-guard-keep').dispatch('click');
  await tick(2);
  assert.equal(env.$('sdd-guard').hidden, true);
  assert.equal(env.$('sdd-content').value, changed);
  assert.equal(host.calls.length, before);

  // Discard switches and reloads the selection.
  env.$('sdd-project').value = otherProject.id;
  env.$('sdd-project').dispatch('change');
  env.$('sdd-guard-discard').dispatch('click');
  await tick();
  assert.ok(host.calls.some(call => call.args.action === 'list_tasks' && call.args.project_id === otherProject.id));
  assert.equal(env.$('sdd-content').value, '');

  // Task switch also needs the guard.
  await loadTask(env);
  draft(env);
  const beforeTask = host.calls.length;
  env.$('sdd-task').value = secondTask.id;
  env.$('sdd-task').dispatch('change');
  await tick(2);
  assert.equal(host.calls.length, beforeTask);
  assert.match(env.$('sdd-guard-text').textContent, /切换任务/);
  env.$('sdd-guard-discard').dispatch('click');
  await tick();
  assert.ok(host.calls.some(call => call.args.action === 'read_task' && call.args.task_id === secondTask.id));

  // Closing the section is guarded and restoring discards the draft.
  draft(env);
  env.$('sdd').open = false;
  env.$('sdd').dispatch('toggle');
  await tick(2);
  assert.equal(env.$('sdd').open, true);
  assert.match(env.$('sdd-guard-text').textContent, /关闭 SDD 共享工作区/);
  env.$('sdd-guard-keep').dispatch('click');
  assert.equal(env.$('sdd').open, true);
  env.$('sdd').open = false;
  env.$('sdd').dispatch('toggle');
  env.$('sdd-guard-discard').dispatch('click');
  await tick(2);
  assert.equal(env.$('sdd').open, false);
  assert.equal(env.$('sdd-content').value, '# 任务二\n', 'discarding on close restores the last read content');
  assert.equal(env.$('sdd-dirty').hidden, true);

  // New project: keep must not register; discard registers by name and switches.
  await loadTask(env);
  draft(env);
  env.$('sdd-project-name').value = '新项目';
  const beforeAdd = host.calls.length;
  env.$('sdd-project-add').dispatch('click');
  await tick(2);
  assert.equal(host.calls.length, beforeAdd, 'creating a project waits for the draft decision');
  assert.match(env.$('sdd-guard-text').textContent, /新建项目/);
  env.$('sdd-guard-keep').dispatch('click');
  await tick(2);
  assert.ok(!host.calls.some(call => call.args.action === 'register_project'));
  assert.equal(env.$('sdd-project-name').value, '新项目');
  assert.equal(env.$('sdd-content').value, '# 草稿修改\n');
  env.$('sdd-project-add').dispatch('click');
  env.$('sdd-guard-discard').dispatch('click');
  await tick();
  const registered = host.calls.find(call => call.args.action === 'register_project');
  assert.equal(registered.args.name, '新项目');
  assert.equal(registered.args.directory, undefined, 'projects are created from a name, not a code directory');
  assert.equal(env.$('sdd-content').value, '');

  // New task: same guard, and the editor is only replaced after discard.
  await loadTask(env);
  draft(env);
  env.$('sdd-task-title').value = '新任务';
  const beforeTaskAdd = host.calls.length;
  env.$('sdd-task-add').dispatch('click');
  await tick(2);
  assert.equal(host.calls.length, beforeTaskAdd, 'creating a task waits for the draft decision');
  assert.match(env.$('sdd-guard-text').textContent, /新建任务/);
  env.$('sdd-guard-keep').dispatch('click');
  await tick(2);
  assert.ok(!host.calls.some(call => call.args.action === 'create_task'));
  assert.equal(env.$('sdd-content').value, '# 草稿修改\n');
  env.$('sdd-task-add').dispatch('click');
  env.$('sdd-guard-discard').dispatch('click');
  await tick();
  assert.ok(host.calls.some(call => call.args.action === 'create_task' && call.args.title === '新任务'));
  assert.equal(env.$('sdd-content').value, '# 新任务\n');
});

test('switching the SDD directory shares the draft guard and cancelling never calls set_workspace', async () => {
  let switched = false;
  const base = handlers();
  const host = makeHost({
    ...base,
    get_workspace: () => switched ? switchedWorkspace : base.get_workspace,
    set_workspace: args => { switched = true;return { ...switchedWorkspace, directory: args.directory }; },
    list_projects: () => switched ? { projects: [] } : base.list_projects,
    list_tasks: () => switched ? { project, tasks: [] } : base.list_tasks,
  });
  const env = environment(host);
  await loadTask(env);
  const changed = draft(env);

  assert.equal(env.$('sdd-workspace-current').textContent, '/home/sdd');
  env.$('sdd-workspace-path').value = '/new/sdd-docs';
  const before = host.calls.length;
  env.$('sdd-workspace-apply').dispatch('click');
  await tick(2);
  assert.equal(host.calls.length, before, 'a guarded workspace switch must not call set_workspace');
  assert.equal(env.$('sdd-guard').hidden, false);
  assert.match(env.$('sdd-guard-text').textContent, /切换 SDD 文档目录/);
  env.$('sdd-guard-keep').dispatch('click');
  await tick(2);
  assert.ok(!host.calls.some(call => call.args.action === 'set_workspace'), 'cancel keeps the current workspace');
  assert.equal(env.$('sdd-workspace-path').value, '/new/sdd-docs');
  assert.equal(env.$('sdd-workspace-current').textContent, '/home/sdd');
  assert.equal(env.$('sdd-content').value, changed, 'the draft survives the cancelled switch');
  assert.equal(env.$('sdd-dirty').hidden, false);

  // Discard switches the document set: projects are re-listed under the new
  // workspace identifier and the previous selection is cleared.
  env.$('sdd-workspace-apply').dispatch('click');
  assert.equal(env.$('sdd-guard').hidden, false);
  env.$('sdd-guard-discard').dispatch('click');
  await tick();
  const setCall = host.calls.find(call => call.args.action === 'set_workspace');
  assert.equal(setCall.args.directory, '/new/sdd-docs');
  assert.equal(setCall.args.workspace_id, undefined);
  const afterSwitch = host.calls.slice(0, host.calls.length);
  assert.ok(afterSwitch.some(call => call.args.action === 'list_projects' && call.args.workspace_id === WS_OTHER));
  assert.equal(env.$('sdd-workspace-current').textContent, '/new/sdd-docs');
  assert.equal(env.$('sdd-workspace-path').value, '');
  assert.equal(env.$('sdd-project').value, '');
  assert.equal(env.$('sdd-task').value, '');
  assert.equal(env.$('sdd-content').value, '');
  assert.equal(env.$('sdd-dirty').hidden, true);
  assert.match(env.$('sdd-message').textContent, /原目录文件保留/);

  // Relative input is refused locally without touching the backend.
  const callsBefore = host.calls.length;
  env.$('sdd-workspace-path').value = 'relative/dir';
  env.$('sdd-workspace-apply').dispatch('click');
  await tick(2);
  assert.equal(host.calls.length, callsBefore);
  assert.match(env.$('sdd-message').textContent, /绝对路径/);
});

test('a failed workspace change keeps the draft, the previous directory, and the typed path', async () => {
  const host = makeHost(handlers({ set_workspace: () => { throw new Error('目录不可写'); } }));
  const env = environment(host);
  await loadTask(env);
  const changed = draft(env);
  env.$('sdd-workspace-path').value = '/readonly/sdd';
  env.$('sdd-workspace-apply').dispatch('click');
  assert.equal(env.$('sdd-guard').hidden, false, 'the draft needs a decision first');
  env.$('sdd-guard-discard').dispatch('click');
  await tick();
  assert.match(env.$('sdd-message').textContent, /切换 SDD 文档目录失败/);
  assert.equal(env.$('sdd-workspace-current').textContent, '/home/sdd', 'the stored directory is unchanged');
  assert.equal(env.$('sdd-workspace-path').value, '/readonly/sdd');
  assert.equal(env.$('sdd-content').value, changed);
  assert.equal(env.$('sdd-dirty').hidden, false);
  assert.equal(env.$('sdd-project').children[1].textContent, '工程', 'the previous project set stays usable');
});

test('save failures and revision conflicts keep the draft and ask for a re-read', async () => {
  const host = makeHost(handlers({
    save_task: () => { throw new Error('文档已在别处修改。请重新读取后再保存，未保存的草稿仍保留在编辑器中。'); },
  }));
  const env = environment(host);
  await loadTask(env);
  const edited = draft(env);
  env.$('sdd-save').dispatch('click');
  await tick();
  assert.equal(env.$('sdd-content').value, edited, 'a failed save must preserve the draft');
  assert.equal(env.$('sdd-dirty').hidden, false);
  assert.match(env.$('sdd-message').textContent, /重新读取/);
  assert.equal((env.$('sdd-message').textContent.match(/草稿仍保留在编辑器中/g) ?? []).length, 1,
    'the backend draft-retained explanation is shown once');
  const failed = host.calls.filter(call => call.args.action === 'save_task').at(-1);
  assert.equal(failed.args.content, edited);
  assert.equal(failed.args.revision, revision, 'saves send the revision from the last read');
  assert.equal(failed.args.workspace_id, WS);

  host.handlers.save_task = args => ({ project, task, content: args.content, revision: 'b'.repeat(64), path: task.path });
  env.$('sdd-save').dispatch('click');
  await tick();
  assert.match(env.$('sdd-message').textContent, /已保存/);
  assert.equal(env.$('sdd-dirty').hidden, true);
  assert.equal(env.$('sdd-content').value, edited);

  // Manual re-read: dirty drafts are guarded instead of being discarded.
  draft(env, '# 再次修改\n');
  env.$('sdd-reload').dispatch('click');
  assert.equal(env.$('sdd-guard').hidden, false);
  assert.match(env.$('sdd-guard-text').textContent, /重新读取/);
  env.$('sdd-guard-keep').dispatch('click');
  assert.equal(env.$('sdd-content').value, '# 再次修改\n');
});

test('a workspace switched by another board rejects the save and keeps the draft', async () => {
  const host = makeHost(handlers({
    save_task: () => { throw new Error('SDD 工作区已切换，请重新读取工作区后再操作；未保存的草稿仍保留在编辑器中。'); },
  }));
  const env = environment(host);
  await loadTask(env);
  const changed = draft(env);
  env.$('sdd-save').dispatch('click');
  await tick();
  assert.match(env.$('sdd-message').textContent, /工作区已被其他看板切换/);
  assert.match(env.$('sdd-message').textContent, /关闭后重新打开/);
  assert.equal(env.$('sdd-content').value, changed);
  assert.equal(env.$('sdd-dirty').hidden, false, 'the draft must not be marked as saved');

  // After the mismatch the board stops sending document calls instead of
  // silently writing into the new workspace.
  const before = host.calls.length;
  env.$('sdd-save').dispatch('click');
  await tick();
  assert.equal(host.calls.length, before, 'no document call is made without a fresh workspace identifier');
  assert.match(env.$('sdd-message').textContent, /工作区未加载/);
  assert.equal(env.$('sdd-content').value, changed);
});

test('a stale listing response cannot overwrite the collection of a new workspace', async () => {
  let releaseFirstList;
  let listCalls = 0;
  let switched = false;
  const base = handlers();
  const host = makeHost({
    ...base,
    get_workspace: () => switched ? switchedWorkspace : base.get_workspace,
    set_workspace: args => { switched = true;return { ...switchedWorkspace, directory: args.directory }; },
    list_projects: () => {
      listCalls++;
      if (listCalls === 1) {
        return new Promise(resolve => { releaseFirstList = () => resolve({ projects: [project] }); });
      }
      return { projects: [otherProject] };
    },
  });
  const env = environment(host);
  env.$('sdd').open = true;
  env.$('sdd').dispatch('toggle');
  await tick();
  assert.equal(typeof releaseFirstList, 'function', 'the first listing is still in flight');

  env.$('sdd-workspace-path').value = '/new/sdd-docs';
  env.$('sdd-workspace-apply').dispatch('click');
  await tick();
  assert.equal(env.$('sdd-workspace-current').textContent, '/new/sdd-docs');
  assert.deepEqual(env.$('sdd-project').children.slice(1).map(option => option.textContent), ['另一个工程']);

  releaseFirstList();
  await tick();
  assert.deepEqual(env.$('sdd-project').children.slice(1).map(option => option.textContent), ['另一个工程'],
    'the old workspace response must not replace the new collection');
  assert.equal(env.$('sdd-project').value, otherProject.id);
});

test('re-reading syncs an externally edited heading into the task picker', async () => {
  const host = makeHost(handlers());
  const env = environment(host);
  await loadTask(env);
  host.handlers.read_task = () => ({
    project, task: { ...task, title: '外部新标题' }, content: '# 外部新标题\n', revision: 'd'.repeat(64), path: task.path,
  });
  env.$('sdd-reload').dispatch('click');
  await tick();
  assert.equal(env.$('sdd-content').value, '# 外部新标题\n');
  assert.ok(env.$('sdd-task').children.map(option => option.textContent).includes('外部新标题'));
});

test('a failed re-read retains the draft and its unsaved state after the discard decision', async () => {
  let failRead = false;
  const source = handlers();
  const host = makeHost({ ...source, read_task: args => {
    if (failRead) throw new Error('读取暂时失败');
    return source.read_task(args);
  } });
  const env = environment(host);await loadTask(env);
  const changed = draft(env);failRead = true;
  env.$('sdd-reload').dispatch('click');env.$('sdd-guard-discard').dispatch('click');await tick();
  assert.equal(env.$('sdd-content').value, changed);
  assert.equal(env.$('sdd-dirty').hidden, false);
  assert.match(env.$('sdd-message').textContent, /读取.*失败/);
});

test('a failed state read never shows the switch as ON and leaves the directory form usable for repair', async () => {
  const host = makeHost(handlers({
    get_workspace: () => { throw new Error('SDD 工作区配置损坏：sdd-workspace.json 不是有效 JSON。'); },
  }));
  const env = environment(host);
  await tick(3);
  assert.equal(env.$('sdd-switch').checked, false, 'an unreadable switch must not be rendered as enabled');
  assert.equal(env.$('sdd-switch').disabled, true);
  assert.equal(env.$('sdd-state').textContent, '不可用');
  assert.match(env.$('sdd-setting-message').textContent, /读取 SDD 设置失败.*配置损坏/);
  assert.match(env.$('sdd-setting-message').className, /error/);
  assert.match(env.$('sdd-note').textContent, /设置不可用/);
  assert.equal(env.$('sdd-workspace-apply').disabled, false, 'the directory form can repair a damaged configuration');
  assert.equal(env.$('sdd-content').disabled, true);
});

test('the read-only monitor gets a disabled shell with a clear management hint', () => {
  const env = environment(null);
  assert.match(env.$('sdd-note').textContent, /请在 Codex 看板中管理/);
  for (const id of ['sdd-content', 'sdd-workspace-path', 'sdd-workspace-apply', 'sdd-project-add', 'sdd-save']) {
    assert.equal(env.$(id).disabled, true, id + ' is read-only in the monitor');
  }
  assert.equal(env.$('sdd-switch').disabled, true, 'the switch cannot be changed in the read-only monitor');
  assert.equal(env.$('sdd-state').textContent, '只读');
  assert.match(env.$('sdd-setting-message').textContent, /仅可在 Codex 看板/);
  assert.match(env.$('sdd-message').textContent, /仅在 Codex 看板/);
  assert.ok(!/innerHTML|insertAdjacentHTML|setInterval\s*\(/.test(SOURCE), 'plain-text UI with no polling or HTML rendering');
  assert.ok(!SOURCE.includes('sdd-project-path'), 'the project form no longer asks for a code directory');
  assert.ok(!HTML.includes('sdd-project-path'), 'no project path input exists in the markup');
  assert.match(HTML, /SDD 文档目录（绝对路径）/);
  assert.match(HTML, /切换后查看该目录下的文档，原目录文件保留。/);
  assert.match(SOURCE, /SDD文档保存在此工作区。项目用于分类，任务各存一份task.md。/);
  assert.match(HTML, /SDD文档保存在此工作区。项目用于分类，任务各存一份task.md。/);
});

test('the SDD switch sits outside the collapsible document section and is always visible', () => {
  const switchIndex = HTML.indexOf('id="sdd-switch"');
  const detailsIndex = HTML.indexOf('<details class="sdd" id="sdd">');
  assert.ok(switchIndex > 0, 'the switch exists');
  assert.ok(detailsIndex > 0, 'the document section exists');
  assert.ok(switchIndex < detailsIndex, 'the switch is rendered before the collapsible section');
  const detailsHtml = HTML.slice(detailsIndex, HTML.lastIndexOf('</details>'));
  assert.ok(!detailsHtml.includes('sdd-switch'), 'the switch is not hidden inside the document details');
  assert.match(HTML, /id="sdd-state"/);
  assert.match(HTML, /id="sdd-setting-message"/);
  assert.match(HTML, /id="sdd-summary-meta"/);
  assert.match(HTML, /<section class="settings" aria-label="SDD 任务文档设置">/,
    'the switch reuses the visible settings card styling (light/dark and narrow screens)');
});

test('turning SDD off protects an unsaved draft, then disables document actions but keeps the root form', async () => {
  const host = makeHost(handlers());
  const env = environment(host);
  await loadTask(env);
  const edited = draft(env);
  const before = host.calls.length;
  env.$('sdd-switch').checked = false;
  env.$('sdd-switch').dispatch('change');
  await tick(2);
  assert.equal(host.calls.length, before, 'no switch save happens while the draft needs a decision');
  assert.equal(env.$('sdd-guard').hidden, false);
  assert.match(env.$('sdd-guard-text').textContent, /关闭 SDD 任务文档/);
  assert.equal(env.$('sdd-content').value, edited, 'the draft is untouched by the guard');

  // Keeping the draft keeps SDD on: the checkbox is restored to the saved state.
  env.$('sdd-guard-keep').dispatch('click');
  await tick(2);
  assert.equal(env.$('sdd-switch').checked, true);
  assert.equal(env.$('sdd-content').value, edited);
  assert.equal(env.$('sdd-dirty').hidden, false);
  assert.ok(!host.calls.some(call => call.args.action === 'set_enabled'));

  // Discarding saves OFF and keeps the last read text read-only.
  env.$('sdd-switch').checked = false;
  env.$('sdd-switch').dispatch('change');
  await tick(2);
  env.$('sdd-guard-discard').dispatch('click');
  await tick(4);
  const off = host.calls.find(call => call.args.action === 'set_enabled');
  assert.equal(off.args.enabled, false);
  assert.equal(env.$('sdd-switch').checked, false);
  assert.equal(env.$('sdd-state').textContent, '已关闭');
  assert.equal(env.$('sdd-content').value, documentBody);
  assert.equal(env.$('sdd-dirty').hidden, true);
  for (const id of ['sdd-content', 'sdd-save', 'sdd-reload', 'sdd-project', 'sdd-task', 'sdd-project-add', 'sdd-task-add']) {
    assert.equal(env.$(id).disabled, true, id + ' is disabled while SDD is off');
  }
  for (const id of ['sdd-workspace-path', 'sdd-workspace-apply']) {
    assert.equal(env.$(id).disabled, false, id + ' stays usable while SDD is off');
  }
  assert.match(env.$('sdd-note').textContent, /已关闭/);
  assert.match(env.$('sdd-setting-message').textContent, /已关闭/);
  assert.match(env.$('sdd-summary-meta').textContent, /已关闭/);
});

test('a failed switch save rolls the switch back and keeps document actions usable', async () => {
  const host = makeHost(handlers({ set_enabled: () => { throw new Error('设置暂时不可用'); } }));
  const env = environment(host);
  await loadTask(env);
  env.$('sdd-switch').checked = false;
  env.$('sdd-switch').dispatch('change');
  await tick(4);
  assert.equal(env.$('sdd-switch').checked, true, 'the failed save rolls back to the confirmed ON state');
  assert.equal(env.$('sdd-state').textContent, '已开启');
  assert.equal(env.$('sdd-setting-message').className, 'setting-message error');
  assert.match(env.$('sdd-setting-message').textContent, /切换 SDD 开关失败.*设置暂时不可用/);
  assert.equal(env.$('sdd-content').disabled, false, 'document actions remain usable after the rollback');
  assert.equal(env.$('sdd-switch').disabled, false);
});

test('a board turned off elsewhere rejects the save, keeps the draft, and syncs the switch', async () => {
  let enabled = true;
  const base = handlers();
  const host = makeHost({
    ...base,
    get_workspace: () => ({ ...workspaceView, enabled }),
    save_task: () => {
      enabled = false;
      throw new Error('SDD 任务文档已关闭，未写入或创建任何文档。请由用户在 Agents 看板开启 SDD 后再操作。');
    },
  });
  const env = environment(host);
  await loadTask(env);
  const changed = draft(env);
  env.$('sdd-save').dispatch('click');
  await tick(6);
  assert.match(env.$('sdd-message').textContent, /SDD 已被关闭/);
  assert.equal(env.$('sdd-content').value, changed, 'the unsaved draft is preserved');
  assert.equal(env.$('sdd-dirty').hidden, false);
  assert.equal(env.$('sdd-switch').checked, false, 'the switch syncs from get_workspace after the rejection');
  assert.equal(env.$('sdd-state').textContent, '已关闭');
  assert.equal(env.$('sdd-content').disabled, true);
  assert.equal(env.$('sdd-workspace-apply').disabled, false, 'the directory setting stays usable for recovery');
  assert.equal(host.calls.filter(call => call.args.action === 'save_task').length, 1, 'no blind retry is attempted');
});

test('re-enabling SDD persists the switch and restores document operations lazily', async () => {
  let enabled = false;
  let listed = false;
  const base = handlers();
  const host = makeHost({
    ...base,
    get_workspace: () => ({ ...workspaceView, enabled }),
    set_enabled: args => { enabled = args.enabled;return { ...workspaceView, enabled, changed: true }; },
    list_projects: () => { listed = true;return base.list_projects; },
  });
  const env = environment(host);
  await tick(3);
  assert.equal(env.$('sdd-switch').checked, false);
  assert.equal(env.$('sdd-state').textContent, '已关闭');
  assert.equal(listed, false, 'no document list is read while SDD is off');

  // Opening the collapsed section while OFF shows the state but reads nothing.
  await open(env);
  assert.equal(listed, false, 'opening the section while OFF does not read documents');
  assert.match(env.$('sdd-message').textContent, /已关闭/);

  env.$('sdd-switch').checked = true;
  env.$('sdd-switch').dispatch('change');
  await tick(6);
  assert.ok(host.calls.some(call => call.args.action === 'set_enabled' && call.args.enabled === true));
  assert.equal(env.$('sdd-switch').checked, true);
  assert.equal(env.$('sdd-state').textContent, '已开启');
  assert.equal(listed, true, 'enabling loads the already-open section');
  assert.equal(env.$('sdd-project').disabled, false);
  assert.equal(env.$('sdd-setting-message').className, 'setting-message');
});

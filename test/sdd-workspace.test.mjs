import test from 'node:test';
import assert from 'node:assert/strict';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_DOC_BYTES, SddWorkspace, runSddAction } from '../src/sdd-workspace.mjs';

const call = (home, action) => runSddAction(home, action);
const LEGACY_PROJECT_ID = 'aaaaaaaaaaaaaaaa';
const LEGACY_TASK_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_FILE = 'sdd-workspace.json';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cta-sdd-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, home: join(root, 'home') };
}

async function doc(home, workspaceId, action, args = {}) {
  return call(home, { action, workspace_id: workspaceId, ...args });
}

async function projectWithTask(t, projectName = '项目') {
  const { root, home } = await fixture(t);
  const workspace = await call(home, { action: 'get_workspace' });
  const registered = await doc(home, workspace.workspace_id, 'register_project', { name: projectName });
  const task = await doc(home, workspace.workspace_id, 'create_task', {
    project_id: registered.project.id, title: '登录页改造',
  });
  return {
    root, home, workspace, workspaceId: workspace.workspace_id, registered, task,
    projectId: registered.project.id, taskId: task.task.id,
  };
}

async function legacyFixture(t) {
  const { root, home } = await fixture(t);
  const sdd = join(home, 'sdd');
  const projectDirectory = join(sdd, LEGACY_PROJECT_ID);
  const taskDirectory = join(projectDirectory, LEGACY_TASK_ID);
  await mkdir(taskDirectory, { recursive: true });
  // Historical metadata: path was a code directory and may no longer exist.
  const goneCodePath = join(root, 'gone-code-project');
  await writeFile(join(projectDirectory, 'project.json'), JSON.stringify({ name: '旧工程', path: goneCodePath }));
  await writeFile(join(taskDirectory, 'task.md'), '# 旧任务\n\n旧内容\n');
  return { root, home, sdd, goneCodePath, projectId: LEGACY_PROJECT_ID, taskId: LEGACY_TASK_ID };
}

test('the default workspace stays home/sdd and reports a stable directory identifier', async t => {
  const { home } = await fixture(t);
  const workspace = await call(home, { action: 'get_workspace' });
  assert.equal(workspace.default, true);
  assert.equal(workspace.configured, false);
  assert.equal(workspace.directory, await realpath(join(home, 'sdd')));
  assert.match(workspace.workspace_id, /^[a-f0-9]{16}$/);
  await assert.rejects(access(join(home, WORKSPACE_FILE)), { code: 'ENOENT' }, 'the default needs no settings file');

  const again = await new SddWorkspace(home).action({ action: 'get_workspace' });
  assert.deepEqual(again, workspace, 'reconnecting keeps the same workspace identifier');
});

test('legacy {name, path} projects keep their folder ID, task ID, content and never expose the code path', async t => {
  const { root, home, sdd, goneCodePath, projectId, taskId } = await legacyFixture(t);
  const workspace = await call(home, { action: 'get_workspace' });
  assert.equal(workspace.default, true);
  const rootPath = await realpath(sdd);

  const listed = await doc(home, workspace.workspace_id, 'list_projects');
  assert.equal(listed.projects.length, 1);
  const legacy = listed.projects[0];
  assert.equal(legacy.id, projectId);
  assert.equal(legacy.name, '旧工程');
  assert.equal(legacy.path, join(rootPath, projectId), 'the view exposes the document folder, not the historical code path');
  assert.ok(!JSON.stringify(listed).includes(goneCodePath));
  await assert.rejects(access(goneCodePath), { code: 'ENOENT' }, 'the historical code path is never created or accessed');

  const tasks = await doc(home, workspace.workspace_id, 'list_tasks', { project_id: projectId });
  assert.equal(tasks.tasks.length, 1);
  assert.equal(tasks.tasks[0].id, taskId);
  assert.equal(tasks.tasks[0].title, '旧任务');
  assert.equal(tasks.tasks[0].path, join(rootPath, projectId, taskId, 'task.md'));
  const read = await doc(home, workspace.workspace_id, 'read_task', { project_id: projectId, task_id: taskId });
  assert.equal(read.content, '# 旧任务\n\n旧内容\n');
  assert.equal(read.path, join(rootPath, projectId, taskId, 'task.md'));

  // Reusing the exact legacy name must not migrate or duplicate the project.
  const metadataFile = join(sdd, projectId, 'project.json');
  const before = await readFile(metadataFile, 'utf8');
  const reused = await doc(home, workspace.workspace_id, 'register_project', { name: '旧工程' });
  assert.equal(reused.created, false);
  assert.equal(reused.project.id, projectId);
  assert.equal(reused.project.name, '旧工程');
  assert.equal(await readFile(metadataFile, 'utf8'), before, 'legacy metadata is left untouched');
  assert.deepEqual(JSON.parse(before), { name: '旧工程', path: goneCodePath });

  // New projects store only the name.
  const fresh = await doc(home, workspace.workspace_id, 'register_project', { name: '新工程' });
  assert.equal(fresh.created, true);
  assert.match(fresh.project.id, /^[a-f0-9]{16}$/);
  assert.notEqual(fresh.project.id, projectId);
  const metadata = JSON.parse(await readFile(join(rootPath, fresh.project.id, 'project.json'), 'utf8'));
  assert.deepEqual(Object.keys(metadata), ['name']);
  assert.equal(metadata.name, '新工程');
});

test('project names are a classification only: trimmed duplicates reuse one folder and no code directory is required', async t => {
  const { home, root } = await fixture(t);
  const workspace = await call(home, { action: 'get_workspace' });
  const first = await doc(home, workspace.workspace_id, 'register_project', { name: '  登录模块  ' });
  assert.equal(first.created, true);
  assert.equal(first.project.name, '登录模块');
  assert.match(first.project.id, /^[a-f0-9]{16}$/);
  const again = await doc(home, workspace.workspace_id, 'register_project', { name: '登录模块' });
  assert.equal(again.created, false);
  assert.equal(again.project.id, first.project.id);
  const other = await doc(home, workspace.workspace_id, 'register_project', { name: '支付模块' });
  assert.notEqual(other.project.id, first.project.id);
  assert.deepEqual((await doc(home, workspace.workspace_id, 'list_projects')).projects.map(project => project.name).sort(),
    ['支付模块', '登录模块'].sort());
  // Only project folders this plugin owns live in the workspace root.
  assert.deepEqual((await readdir(join(home, 'sdd'))).sort(), [first.project.id, other.project.id].sort());
  assert.deepEqual(await readdir(join(home, 'sdd', first.project.id)), ['project.json']);

  await assert.rejects(doc(home, workspace.workspace_id, 'register_project', { name: '' }), /名称不能为空/);
  await assert.rejects(doc(home, workspace.workspace_id, 'register_project', { name: '   ' }), /名称不能为空/);
  await assert.rejects(doc(home, workspace.workspace_id, 'register_project', { name: 'a'.repeat(121) }), /120/);
  await assert.rejects(doc(home, workspace.workspace_id, 'register_project', { name: '命名', directory: root }),
    /Unrecognized|unrecognized/i, 'a code directory is no longer part of the project contract');
  await assert.rejects(doc(home, workspace.workspace_id, 'register_project', { name: '命名', path: root }),
    /Unrecognized|unrecognized/i);
});

test('concurrent registrations of one name share a single folder and never lose later task files', async t => {
  const { home } = await fixture(t);
  const workspace = await call(home, { action: 'get_workspace' });
  const id = workspace.workspace_id;
  const first = new SddWorkspace(home);
  const second = new SddWorkspace(home);
  const results = await Promise.all([
    first.action({ action: 'register_project', workspace_id: id, name: '并发项目' }),
    second.action({ action: 'register_project', workspace_id: id, name: '并发项目' }),
  ]);
  assert.deepEqual(results.map(result => result.project.id), [results[0].project.id, results[0].project.id]);
  assert.equal(results.filter(result => result.created).length, 1, 'exactly one registration creates the folder');
  assert.equal(results[0].project.name, '并发项目');
  const entries = (await readdir(join(home, 'sdd'))).filter(entry => /^[a-f0-9]{16}$/.test(entry));
  assert.deepEqual(entries, [results[0].project.id], 'no duplicate name folder is left behind');

  // A task created immediately after the registration must still be there.
  const task = await doc(home, id, 'create_task', { project_id: results[0].project.id, title: '登记后的任务' });
  assert.match(await readFile(task.path, 'utf8'), /登记后的任务/);
  const listed = await doc(home, id, 'list_tasks', { project_id: results[0].project.id });
  assert.deepEqual(listed.tasks.map(item => item.id), [task.task.id]);
  assert.deepEqual((await doc(home, id, 'list_projects')).projects.map(project => project.name), ['并发项目']);
});

test('an existing project folder without metadata is never overwritten or deleted', async t => {
  const { home } = await fixture(t);
  const workspace = await call(home, { action: 'get_workspace' });
  const registered = await doc(home, workspace.workspace_id, 'register_project', { name: '孤儿项目' });
  const projectDirectory = join(home, 'sdd', registered.project.id);
  // Simulate a leftover folder whose metadata is missing but that may already
  // contain documents written by another process.
  await unlink(join(projectDirectory, 'project.json'));
  await writeFile(join(projectDirectory, 'keep.txt'), 'do not delete\n');

  await assert.rejects(doc(home, workspace.workspace_id, 'register_project', { name: '孤儿项目' }),
    error => error.code === 'PROJECT_CONFLICT' && /不匹配|缺失/.test(error.message));
  assert.equal(await readFile(join(projectDirectory, 'keep.txt'), 'utf8'), 'do not delete\n');
  await assert.rejects(access(join(projectDirectory, 'project.json')), { code: 'ENOENT' },
    'the existing folder must not be given fresh metadata');
  assert.deepEqual((await doc(home, workspace.workspace_id, 'list_projects')).projects, []);
});

test('a symlink at the name-derived project ID never exposes or rewrites external metadata', async t => {
  const { root, home } = await fixture(t);
  const workspace = await call(home, { action: 'get_workspace' });
  const registered = await doc(home, workspace.workspace_id, 'register_project', { name: '链接项目' });
  const id = registered.project.id;
  // Free the name-derived ID again, then point it at an external directory.
  await rm(join(home, 'sdd', id), { recursive: true, force: true });
  const external = join(root, 'external-project');
  const externalMeta = JSON.stringify({ name: '外部项目', path: join(root, 'secret-code') });
  await mkdir(external);
  await writeFile(join(external, 'project.json'), externalMeta);
  await writeFile(join(external, 'keep.txt'), 'external content\n');
  await symlink(external, join(home, 'sdd', id));

  await assert.rejects(doc(home, workspace.workspace_id, 'register_project', { name: '链接项目' }),
    error => error.code === 'UNSAFE_PATH' && /符号链接|不安全/.test(error.message));
  assert.equal(await readFile(join(external, 'project.json'), 'utf8'), externalMeta,
    'external metadata is neither read into the workspace nor rewritten');
  assert.equal(await readFile(join(external, 'keep.txt'), 'utf8'), 'external content\n');
  assert.deepEqual((await doc(home, workspace.workspace_id, 'list_projects')).projects, []);
  assert.equal((await lstat(join(home, 'sdd', id))).isSymbolicLink(), true, 'the symlink is left untouched');
});

test('selecting the default directory explicitly persists a state that matches get_workspace', async t => {
  const { home } = await fixture(t);
  const initial = await call(home, { action: 'get_workspace' });
  assert.equal(initial.default, true);
  const selected = await call(home, { action: 'set_workspace', directory: join(home, 'sdd') });
  assert.equal(selected.default, false);
  assert.equal(selected.configured, true);
  assert.equal(selected.changed, true, 'the explicit selection is persisted even when it is the default path');
  assert.deepEqual(JSON.parse(await readFile(join(home, WORKSPACE_FILE), 'utf8')), { directory: selected.directory });
  const current = await call(home, { action: 'get_workspace' });
  assert.equal(current.directory, selected.directory);
  assert.equal(current.workspace_id, selected.workspace_id);
  assert.equal(current.default, selected.default);
  assert.equal(current.configured, selected.configured);

  const again = await call(home, { action: 'set_workspace', directory: join(home, 'sdd') });
  assert.equal(again.changed, false);
  const after = await call(home, { action: 'get_workspace' });
  assert.deepEqual(after, {
    directory: again.directory, workspace_id: again.workspace_id,
    default: again.default, configured: again.configured,
  });
});

test('switching the workspace switches the document set and leaves the old directory and unrelated files untouched', async t => {
  const { root, home } = await fixture(t);
  const initial = await call(home, { action: 'get_workspace' });
  const project = await doc(home, initial.workspace_id, 'register_project', { name: '共享项目' });
  const created = await doc(home, initial.workspace_id, 'create_task', { project_id: project.project.id, title: '旧目录任务' });
  await doc(home, initial.workspace_id, 'save_task', {
    project_id: project.project.id, task_id: created.task.id, content: '# 旧目录任务\n\n唯一标记-old-root\n', revision: created.revision,
  });
  const oldDocumentPath = join(await realpath(join(home, 'sdd')), project.project.id, created.task.id, 'task.md');

  // A fresh directory with unrelated content the plugin must never touch.
  const nextRoot = join(root, 'shared-docs');
  await mkdir(join(nextRoot, 'unrelated'), { recursive: true });
  await writeFile(join(nextRoot, 'keep.txt'), 'do not touch\n');
  await writeFile(join(nextRoot, 'unrelated', 'note.md'), '# unrelated\n');

  const switched = await call(home, { action: 'set_workspace', directory: nextRoot });
  assert.equal(switched.directory, await realpath(nextRoot));
  assert.equal(switched.changed, true);
  assert.notEqual(switched.workspace_id, initial.workspace_id);
  assert.deepEqual(JSON.parse(await readFile(join(home, WORKSPACE_FILE), 'utf8')), { directory: await realpath(nextRoot) });
  assert.equal(await readFile(join(nextRoot, 'keep.txt'), 'utf8'), 'do not touch\n');
  assert.equal(await readFile(join(nextRoot, 'unrelated', 'note.md'), 'utf8'), '# unrelated\n');

  // The new root has its own document set; the old one is neither copied nor moved.
  assert.deepEqual((await doc(home, switched.workspace_id, 'list_projects')).projects, []);
  assert.equal(await readFile(oldDocumentPath, 'utf8'), '# 旧目录任务\n\n唯一标记-old-root\n');
  const freshProject = await doc(home, switched.workspace_id, 'register_project', { name: '共享项目' });
  assert.equal(freshProject.project.id, project.project.id,
    'the folder ID is derived from the name, but it is a separate folder in the new workspace');
  assert.equal(freshProject.project.path, join(await realpath(nextRoot), freshProject.project.id));
  assert.notEqual(freshProject.project.path, project.project.path);
  const freshTask = await doc(home, switched.workspace_id, 'create_task', { project_id: freshProject.project.id, title: '新目录任务' });
  await doc(home, switched.workspace_id, 'save_task', {
    project_id: freshProject.project.id, task_id: freshTask.task.id, content: '# 新目录任务\n\n唯一标记-new-root\n', revision: freshTask.revision,
  });
  assert.equal(await readFile(join(await realpath(nextRoot), freshProject.project.id, freshTask.task.id, 'task.md'), 'utf8'),
    '# 新目录任务\n\n唯一标记-new-root\n');
  assert.deepEqual((await readdir(join(await realpath(nextRoot), freshProject.project.id))).sort(), ['project.json', freshTask.task.id].sort());

  // Switching back restores the original id and its untouched documents.
  const restored = await call(home, { action: 'set_workspace', directory: join(home, 'sdd') });
  assert.equal(restored.workspace_id, initial.workspace_id);
  const tasks = await doc(home, restored.workspace_id, 'list_tasks', { project_id: project.project.id });
  assert.equal(tasks.tasks.length, 1);
  assert.deepEqual((await doc(home, restored.workspace_id, 'read_task', {
    project_id: project.project.id, task_id: created.task.id,
  })).content, '# 旧目录任务\n\n唯一标记-old-root\n');

  // Reconnecting (a fresh instance) reads the persisted workspace.
  const reconnect = await new SddWorkspace(home).action({ action: 'get_workspace' });
  assert.equal(reconnect.directory, await realpath(join(home, 'sdd')));
  assert.equal(reconnect.default, false);
});

test('invalid workspace paths and configurations are rejected instead of switching silently', async t => {
  const { root, home } = await fixture(t);
  await call(home, { action: 'get_workspace' });
  await assert.rejects(call(home, { action: 'set_workspace', directory: 'relative/path' }), /绝对路径/);
  await writeFile(join(root, 'a-file.txt'), 'not a directory');
  await assert.rejects(call(home, { action: 'set_workspace', directory: join(root, 'a-file.txt') }), /目录/);
  await assert.rejects(call(home, { action: 'set_workspace', directory: '' }), /不能为空/);
  // The default remains in effect after every rejected attempt.
  assert.equal((await call(home, { action: 'get_workspace' })).default, true);

  const settings = join(home, WORKSPACE_FILE);
  await writeFile(settings, '{corrupt');
  await assert.rejects(call(home, { action: 'get_workspace' }), /配置损坏/);
  await assert.rejects(doc(home, '0'.repeat(16), 'list_projects'), /配置损坏/);
  await writeFile(settings, JSON.stringify({ directory: 'relative/path' }));
  await assert.rejects(call(home, { action: 'get_workspace' }), /配置无效/);
  await writeFile(settings, JSON.stringify({ path: join(root, 'elsewhere') }));
  await assert.rejects(call(home, { action: 'get_workspace' }), /配置无效/);
  await writeFile(settings, JSON.stringify({ directory: join(root, 'missing-dir') }));
  await assert.rejects(call(home, { action: 'get_workspace' }), /不存在/);

  // An explicit new directory repairs a damaged configuration.
  const repaired = await call(home, { action: 'set_workspace', directory: join(root, 'repaired-docs') });
  assert.equal(repaired.directory, await realpath(join(root, 'repaired-docs')));
  assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')), { directory: await realpath(join(root, 'repaired-docs')) });
});

test('a board from an old workspace cannot write into a newly selected one even with identical IDs and revisions', async t => {
  const { root, home } = await fixture(t);
  const oldBoard = await call(home, { action: 'get_workspace' });
  const project = await doc(home, oldBoard.workspace_id, 'register_project', { name: '共享项目' });
  const task = await doc(home, oldBoard.workspace_id, 'create_task', { project_id: project.project.id, title: '跨看板任务' });
  const saved = await doc(home, oldBoard.workspace_id, 'save_task', {
    project_id: project.project.id, task_id: task.task.id, content: '# 同一文档\n', revision: task.revision,
  });
  const oldRoot = await realpath(join(home, 'sdd'));

  // The second board switches the workspace every board shares.
  const nextRoot = join(root, 'board-b-docs');
  const secondBoard = await call(home, { action: 'set_workspace', directory: nextRoot });
  const nextReal = await realpath(nextRoot);
  // The new root happens to contain the very same project/task IDs with the
  // same content (same revision): only the workspace fence may reject the
  // stale board.
  await mkdir(join(nextReal, project.project.id, task.task.id), { recursive: true });
  await writeFile(join(nextReal, project.project.id, 'project.json'), JSON.stringify({ name: '共享项目' }));
  await writeFile(join(nextReal, project.project.id, task.task.id, 'task.md'), '# 同一文档\n');
  const same = await doc(home, secondBoard.workspace_id, 'read_task', {
    project_id: project.project.id, task_id: task.task.id,
  });
  assert.equal(same.revision, saved.revision, 'the fixture really has the same revision');
  assert.equal(same.path, join(nextReal, project.project.id, task.task.id, 'task.md'));

  // The old board's next save must be refused and must not touch the new root.
  await assert.rejects(doc(home, oldBoard.workspace_id, 'save_task', {
    project_id: project.project.id, task_id: task.task.id, content: '# 旧看板草稿\n', revision: same.revision,
  }), error => error.code === 'WORKSPACE_CHANGED'
    && /重新读取工作区/.test(error.message) && /草稿仍保留/.test(error.message));
  assert.equal(await readFile(join(nextReal, project.project.id, task.task.id, 'task.md'), 'utf8'), '# 同一文档\n');
  // Reads and listings from the stale board are fenced too.
  await assert.rejects(doc(home, oldBoard.workspace_id, 'read_task', {
    project_id: project.project.id, task_id: task.task.id,
  }), error => error.code === 'WORKSPACE_CHANGED');
  await assert.rejects(doc(home, oldBoard.workspace_id, 'list_tasks', { project_id: project.project.id }),
    error => error.code === 'WORKSPACE_CHANGED');
  // The old directory keeps its own document untouched as well.
  assert.equal(await readFile(join(oldRoot, project.project.id, task.task.id, 'task.md'), 'utf8'), '# 同一文档\n');

  // A board that re-read the workspace can save normally.
  const current = await call(home, { action: 'get_workspace' });
  const updated = await doc(home, current.workspace_id, 'save_task', {
    project_id: project.project.id, task_id: task.task.id, content: '# 新看板保存\n', revision: same.revision,
  });
  assert.equal(await readFile(updated.path, 'utf8'), '# 新看板保存\n');
});

test('task documents are plain Markdown with versioned reads, atomic saves, and persistence across instances', async t => {
  const { home, projectId, taskId, task, workspaceId } = await projectWithTask(t);
  assert.match(taskId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(task.task.title, '登录页改造');
  assert.ok(task.path.startsWith(join(await realpath(join(home, 'sdd')), projectId, taskId)));
  for (const section of ['## 目标', '## 范围', '## 计划', '## 验收条件']) assert.match(task.content, new RegExp(section));
  assert.match(task.content, /^# 登录页改造/);

  const listed = await doc(home, workspaceId, 'list_tasks', { project_id: projectId });
  assert.equal(listed.tasks.length, 1);
  assert.equal(listed.tasks[0].title, '登录页改造');
  assert.equal(listed.tasks[0].content, undefined, 'listing must not return document bodies');
  assert.equal(listed.project.path, join(await realpath(join(home, 'sdd')), projectId));

  const read = await doc(home, workspaceId, 'read_task', { project_id: projectId, task_id: taskId });
  assert.equal(read.content, task.content);
  assert.equal(read.revision, task.revision);
  assert.ok(read.path.startsWith('/'));
  assert.equal(read.task.path, read.path);
  assert.deepEqual(read.content, await readFile(read.path, 'utf8'));

  const saved = await doc(home, workspaceId, 'save_task', {
    project_id: projectId, task_id: taskId,
    content: '# 新标题\n\n## 目标\n\n完成登录页。\n', revision: read.revision,
  });
  assert.notEqual(saved.revision, read.revision);
  assert.equal(await readFile(saved.path, 'utf8'), '# 新标题\n\n## 目标\n\n完成登录页。\n');

  const fresh = new SddWorkspace(home);
  const persisted = await fresh.action({ action: 'read_task', workspace_id: workspaceId, project_id: projectId, task_id: taskId });
  assert.equal(persisted.content, saved.content);
  assert.equal(persisted.revision, saved.revision);
  assert.equal((await fresh.action({ action: 'list_tasks', workspace_id: workspaceId, project_id: projectId })).tasks[0].title, '新标题');
  assert.deepEqual((await readdir(join(home, 'sdd', projectId, taskId))).sort(), ['task.md']);
});

test('stale revisions, concurrent saves, and external edits never overwrite silently', async t => {
  const { home, projectId, taskId, workspaceId } = await projectWithTask(t);
  const workspaceA = new SddWorkspace(home);
  const workspaceB = new SddWorkspace(home);
  const read = await workspaceA.action({ action: 'read_task', workspace_id: workspaceId, project_id: projectId, task_id: taskId });

  const first = await workspaceA.action({
    action: 'save_task', workspace_id: workspaceId, project_id: projectId, task_id: taskId,
    content: '# 版本二\n', revision: read.revision,
  });
  await assert.rejects(workspaceB.action({
    action: 'save_task', workspace_id: workspaceId, project_id: projectId, task_id: taskId,
    content: '# 版本三\n', revision: read.revision,
  }), error => error.code === 'REVISION_CONFLICT' && /重新读取/.test(error.message));
  assert.equal(await readFile(first.path, 'utf8'), '# 版本二\n');

  // An external Agent may edit task.md directly between read and save.
  await writeFile(first.path, '# 外部修改\n');
  await assert.rejects(workspaceA.action({
    action: 'save_task', workspace_id: workspaceId, project_id: projectId, task_id: taskId,
    content: '# 覆盖尝试\n', revision: first.revision,
  }), error => error.code === 'REVISION_CONFLICT');
  assert.equal(await readFile(first.path, 'utf8'), '# 外部修改\n');
  const external = await workspaceA.action({ action: 'read_task', workspace_id: workspaceId, project_id: projectId, task_id: taskId });
  assert.equal(external.content, '# 外部修改\n');

  // Two different board instances holding the same revision: exactly one wins.
  const concurrent = await Promise.allSettled([
    workspaceA.action({ action: 'save_task', workspace_id: workspaceId, project_id: projectId, task_id: taskId, content: '# 并发 A\n', revision: external.revision }),
    workspaceB.action({ action: 'save_task', workspace_id: workspaceId, project_id: projectId, task_id: taskId, content: '# 并发 B\n', revision: external.revision }),
  ]);
  const fulfilled = concurrent.filter(result => result.status === 'fulfilled');
  const rejected = concurrent.filter(result => result.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'only one concurrent save may succeed');
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /重新读取|正在被其他进程保存/);
  assert.ok(['# 并发 A\n', '# 并发 B\n'].includes(await readFile(external.path, 'utf8')));
  assert.deepEqual((await readdir(join(home, 'sdd', projectId, taskId))).sort(), ['task.md'], 'the write lock must be released');
});

test('invalid identifiers, symlink escapes, and oversized documents are rejected without touching the original', async t => {
  const { home, root, projectId, taskId, task, workspaceId } = await projectWithTask(t);

  await assert.rejects(doc(home, workspaceId, 'list_tasks', { project_id: '../sdd' }), /项目编号无效/);
  await assert.rejects(doc(home, workspaceId, 'read_task', { project_id: projectId, task_id: 'not-a-task' }), /任务编号无效/);
  await assert.rejects(doc(home, workspaceId, 'read_task', { project_id: 'ffffffffffffffff', task_id: taskId }), /不存在/);
  await assert.rejects(doc(home, workspaceId, 'read_task', { project_id: projectId, task_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }), /不存在/);
  await assert.rejects(doc(home, workspaceId, 'save_task', { project_id: projectId, task_id: taskId, content: 'x', revision: 'not-a-revision' }), /版本无效/);
  await assert.rejects(doc(home, workspaceId, 'save_task', { project_id: projectId, task_id: taskId, content: 'x', revision: task.revision, extra: true }), /Unrecognized|unrecognized/i);
  await assert.rejects(call(home, { action: 'read_task', project_id: projectId, task_id: taskId }), /Unrecognized|unrecognized|workspace_id/i,
    'document actions require the workspace identifier');

  // A symlinked task.md must never be followed, even if it points at a valid file.
  const outside = join(root, 'outside.md');
  await writeFile(outside, '# 外部文档\n');
  const taskDirectory = join(home, 'sdd', projectId, taskId);
  const documentPath = join(taskDirectory, 'task.md');
  await unlink(documentPath);
  await symlink(outside, documentPath);
  await assert.rejects(doc(home, workspaceId, 'read_task', { project_id: projectId, task_id: taskId }), /符号链接|不安全/);
  await assert.rejects(doc(home, workspaceId, 'save_task', { project_id: projectId, task_id: taskId, content: '# 覆盖\n', revision: task.revision }), /符号链接|不安全/);
  assert.equal(await readFile(outside, 'utf8'), '# 外部文档\n');
  await unlink(documentPath);

  // A symlinked project directory is ignored while listing and refused on access.
  const externalProject = join(root, 'external-project');
  await mkdir(externalProject);
  await writeFile(join(externalProject, 'project.json'), JSON.stringify({ name: 'external' }));
  const fakeId = 'dddddddddddddddd';
  await symlink(externalProject, join(home, 'sdd', fakeId));
  const listed = await doc(home, workspaceId, 'list_projects');
  assert.ok(!listed.projects.some(project => project.id === fakeId));
  await assert.rejects(doc(home, workspaceId, 'read_task', { project_id: fakeId, task_id: taskId }), /不安全|无效/);
  await unlink(join(home, 'sdd', fakeId));

  // Recreate the document, then check the 256 KiB cap.
  const recreated = await doc(home, workspaceId, 'create_task', { project_id: projectId, title: '大小限制' });
  await assert.rejects(doc(home, workspaceId, 'save_task', {
    project_id: projectId, task_id: recreated.task.id,
    content: 'x'.repeat(MAX_DOC_BYTES + 1), revision: recreated.revision,
  }), /256 KiB/);
  assert.ok((await readFile(recreated.path, 'utf8')).includes('大小限制'));
  await writeFile(recreated.path, 'x'.repeat(MAX_DOC_BYTES + 1));
  await assert.rejects(doc(home, workspaceId, 'read_task', { project_id: projectId, task_id: recreated.task.id }), /256 KiB/);
  await unlink(join(home, 'sdd', projectId, recreated.task.id, 'task.md'));

  // A symlinked lock file is also refused instead of being followed or deleted.
  const locked = await doc(home, workspaceId, 'create_task', { project_id: projectId, title: '锁测试' });
  const lockTarget = join(root, 'lock-target');
  await writeFile(lockTarget, '{}');
  await symlink(lockTarget, join(home, 'sdd', projectId, locked.task.id, '.task.md.lock'));
  await assert.rejects(doc(home, workspaceId, 'save_task', {
    project_id: projectId, task_id: locked.task.id,
    content: '# 不会写入\n', revision: locked.revision,
  }), /锁路径不安全|不安全/);
  assert.equal(await readFile(lockTarget, 'utf8'), '{}');
  assert.match(await readFile(locked.path, 'utf8'), /锁测试/);
});

test('tasks stay isolated per project and unknown projects cannot read other documents', async t => {
  const { root, home, projectId, taskId, workspaceId } = await projectWithTask(t);
  const second = await doc(home, workspaceId, 'register_project', { name: '另一个项目' });
  assert.equal((await doc(home, workspaceId, 'list_tasks', { project_id: second.project.id })).tasks.length, 0);
  await assert.rejects(doc(home, workspaceId, 'read_task', { project_id: second.project.id, task_id: taskId }), /不存在/);
  const tasks = await doc(home, workspaceId, 'list_tasks', { project_id: projectId });
  assert.equal(tasks.tasks.length, 1);
  assert.equal(tasks.tasks[0].id, taskId);
  assert.deepEqual((await readdir(join(home, 'sdd', second.project.id))).sort(), ['project.json']);
  await access(join(home, 'sdd', projectId, taskId, 'task.md'));
  assert.ok(root);
});

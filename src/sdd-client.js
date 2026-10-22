// Shared lightweight SDD documents for the Agents board. The section first
// resolves one shared document workspace (home/sdd by default); projects only
// classify documents and each task is one task.md. Loaded with the panel, but
// nothing is read until the user opens the section. The read-only HTTP monitor
// shows the section without letting it write: all edits go through the app-only
// panel_sdd MCP tool. Every document call carries the workspace identifier the
// server handed out, so a board that still points at an old workspace can never
// write a stale draft into a newly selected one.
(() => {
  const READONLY = '请在 Codex 看板中管理共享任务文档。';
  const DEFAULT_NOTE = 'SDD文档保存在此工作区。项目用于分类，任务各存一份task.md。';
  const $ = id => document.getElementById(id);
  const option = (value, text) => {
    const item = document.createElement('option');
    item.value = value;item.textContent = text;return item;
  };
  const state = {
    initialized: false, loaded: false,
    // Outstanding reads; cancelled requests must not leave the board busy.
    pendingProjects: 0, pendingTasks: 0, pendingDoc: 0,
    saving: false, busyAdd: false, busyTask: false, busyWorkspace: false,
    projects: [], tasks: [], projectId: '', taskId: '',
    directory: '', workspaceId: '',
    baseline: '', revision: '', path: '', guard: null,
    // Response ordering for this board: a slower response from an older
    // request never overwrites the collection selected after it.
    listSeq: 0, tasksSeq: 0, docSeq: 0,
  };
  const canEdit = () => Boolean(window.agentsHost);
  const editor = () => $('sdd-content');
  const read = () => editor().value ?? '';
  const dirty = () => Boolean(state.taskId) && read() !== state.baseline;

  function message(text, error = false) {
    const node = $('sdd-message');
    if (!node) return;
    node.textContent = text;
    node.className = 'sdd-message' + (error ? ' error' : '');
  }

  const workspaceChanged = error => /工作区已切换|工作区标识/.test(error?.message ?? '');
  const WORKSPACE_STALE = 'SDD 工作区已被其他看板切换，当前草稿仍保留。请关闭后重新打开此区域，再重新读取后保存。';

  function markWorkspaceChanged() {
    // Do not silently re-read the new workspace: the editor still holds a draft
    // from the old document set. Only an explicit close/re-open picks it up.
    state.loaded = false;
    state.workspaceId = '';
    updateBusy();
  }

  function updateDirty() {
    $('sdd-dirty').hidden = !dirty();
    $('sdd-dirty').textContent = '未保存';
  }

  function updateBusy() {
    const editable = canEdit();
    const busy = state.saving || state.pendingProjects > 0 || state.pendingTasks > 0 || state.pendingDoc > 0
      || state.busyAdd || state.busyTask || state.busyWorkspace;
    const disabled = !editable || busy;
    $('sdd-workspace-path').disabled = disabled;
    $('sdd-workspace-apply').disabled = disabled;
    $('sdd-project').disabled = disabled || !state.projects.length;
    $('sdd-task').disabled = disabled || !state.projectId || !state.tasks.length;
    for (const id of ['sdd-project-name', 'sdd-project-add', 'sdd-task-title', 'sdd-task-add']) {
      $(id).disabled = disabled;
    }
    $('sdd-content').disabled = disabled || !state.taskId;
    $('sdd-save').disabled = disabled || !state.taskId;
    $('sdd-reload').disabled = disabled || !state.taskId;
    $('sdd-copy').disabled = disabled || !state.path;
  }

  function renderWorkspace() {
    $('sdd-workspace-current').textContent = state.directory || '打开后加载';
  }

  function renderProjects() {
    const select = $('sdd-project');
    // Projects are a classification only: the picker shows names, never a path.
    select.replaceChildren(option('', state.projects.length ? '请选择项目' : '尚无项目'),
      ...state.projects.map(project => option(project.id, project.name)));
    select.value = state.projectId;
    updateBusy();
  }

  function renderTasks() {
    const select = $('sdd-task');
    select.replaceChildren(option('', state.tasks.length ? '请选择任务' : '尚无任务'),
      ...state.tasks.map(task => option(task.id, task.title)));
    select.value = state.taskId;
    updateBusy();
  }

  function renderPath() {
    $('sdd-path').textContent = state.path || '尚未选择任务';
    $('sdd-copy').disabled = !state.path;
  }

  function resetDocument() {
    state.taskId = '';state.baseline = '';state.revision = '';state.path = '';
    editor().value = '';
    renderPath();renderTasks();updateDirty();updateBusy();
  }

  function showGuard(target) {
    state.guard = target;
    const labels = {
      project: ['切换项目', '放弃修改并切换项目'],
      task: ['切换任务', '放弃修改并切换任务'],
      workspace: ['切换 SDD 文档目录', '放弃修改并切换目录'],
      add_project: ['新建项目', '放弃修改并新建项目'],
      add_task: ['新建任务', '放弃修改并新建任务'],
      reload: ['重新读取', '放弃修改并重新读取'],
      close: ['关闭 SDD 共享工作区', '放弃修改并关闭'],
    };
    const [verb, discardLabel] = labels[target.type] ?? labels.reload;
    $('sdd-guard-text').textContent = `当前任务有未保存的修改。要放弃修改并${verb}吗？也可以保留修改，继续编辑。`;
    $('sdd-guard-keep').textContent = '保留未保存修改';
    $('sdd-guard-discard').textContent = discardLabel;
    $('sdd-guard').hidden = false;
  }

  function hideGuard() {
    state.guard = null;
    $('sdd-guard').hidden = true;
  }

  async function api(action, args = {}) {
    if (!window.agentsHost) throw new Error(READONLY);
    return window.agentsHost.call('panel_sdd', { action, ...args });
  }

  // Document actions are fenced to the workspace this board last read. Without
  // an identifier the server refuses them, so no stale board can write.
  async function docApi(action, args = {}) {
    if (!state.workspaceId) throw new Error('SDD 工作区未加载，请关闭后重新打开此区域。');
    return api(action, { ...args, workspace_id: state.workspaceId });
  }

  function clearSelection() {
    state.projects = [];state.tasks = [];state.projectId = '';
    resetDocument();
    renderProjects();renderWorkspace();
  }

  async function applyWorkspace(directory) {
    if (!canEdit() || state.busyWorkspace) return;
    if (state.saving) { message('正在保存，请稍后再切换 SDD 文档目录。', true);return; }
    // Any in-flight response now belongs to the previous document set.
    state.listSeq++;state.tasksSeq++;state.docSeq++;
    state.busyWorkspace = true;updateBusy();message('正在切换 SDD 文档目录…');
    try {
      const data = await api('set_workspace', { directory });
      state.directory = data.directory ?? directory;
      state.workspaceId = data.workspace_id ?? '';
      $('sdd-workspace-path').value = '';
      // A different workspace is a different document set: the old selection is
      // cleared and the old directory is left untouched on disk.
      clearSelection();
      state.loaded = false;
      // The listing below normally reports its own hint; on success the saved
      // directory confirmation is the more useful message, so restore it.
      const ok = await loadProjects();
      if (ok) message(`SDD 文档目录已切换为 ${state.directory}。切换后查看该目录下的文档，原目录文件保留。`);
    } catch (error) {
      // The draft and the previous collection stay exactly as they were.
      message('切换 SDD 文档目录失败：' + error.message, true);
    } finally {
      state.busyWorkspace = false;updateBusy();updateDirty();
    }
  }

  async function loadProjects() {
    if (!canEdit()) return false;
    const seq = ++state.listSeq;
    state.pendingProjects++;updateBusy();
    let ok = false;
    try {
      const workspace = await api('get_workspace');
      if (seq !== state.listSeq) return false;
      state.directory = workspace.directory ?? '';
      state.workspaceId = workspace.workspace_id ?? '';
      renderWorkspace();
      const data = await docApi('list_projects');
      if (seq !== state.listSeq) return false;
      state.projects = data.projects ?? [];
      state.loaded = true;
      if (!state.projects.some(project => project.id === state.projectId)) {
        /* Keep the first project ready; the task document itself is read on
           demand, never as part of listing. */
        state.projectId = state.projects[0]?.id ?? '';
        state.tasks = [];
        resetDocument();renderProjects();
      } else renderProjects();
      message(state.projects.length ? '选择项目后打开任务文档。' : '尚无项目，输入项目名称即可新建。');
      ok = true;
    } catch (error) {
      if (seq !== state.listSeq) return false;
      if (workspaceChanged(error)) { markWorkspaceChanged();message(WORKSPACE_STALE, true); }
      else message('读取 SDD 工作区失败：' + error.message, true);
    } finally {
      state.pendingProjects--;updateBusy();
    }
    if (ok && state.projectId && !state.tasks.length) await loadTasks();
    return ok;
  }

  async function loadTasks() {
    if (!canEdit() || !state.projectId) return;
    const seq = ++state.tasksSeq;
    const projectId = state.projectId;
    state.pendingTasks++;updateBusy();
    try {
      const data = await docApi('list_tasks', { project_id: projectId });
      if (seq !== state.tasksSeq || projectId !== state.projectId) return;
      state.tasks = data.tasks ?? [];
      if (!state.tasks.some(task => task.id === state.taskId)) resetDocument();
      renderTasks();
      message(state.tasks.length ? '选择任务以读取 task.md。' : '此项目尚无任务，可输入标题新建。');
    } catch (error) {
      if (seq !== state.tasksSeq || projectId !== state.projectId) return;
      if (workspaceChanged(error)) { markWorkspaceChanged();message(WORKSPACE_STALE, true); }
      else message('读取任务失败：' + error.message, true);
    } finally {
      state.pendingTasks--;updateBusy();
    }
  }

  async function selectProject(projectId) {
    state.projectId = projectId;state.tasks = [];resetDocument();renderProjects();
    if (projectId) await loadTasks();
  }

  async function openTask(taskId) {
    if (!state.projectId || !taskId) { resetDocument();return; }
    const seq = ++state.docSeq;
    const projectId = state.projectId;
    state.pendingDoc++;updateBusy();
    try {
      const doc = await docApi('read_task', { project_id: projectId, task_id: taskId });
      if (seq !== state.docSeq || projectId !== state.projectId) return;
      state.taskId = taskId;state.revision = doc.revision;state.baseline = doc.content;
      state.path = doc.path;editor().value = doc.content;
      if (doc.task) {
        // An external edit may have changed the heading; keep the picker in sync.
        state.tasks = state.tasks.map(task => task.id === taskId
          ? { ...task, title: doc.task.title, revision: doc.task.revision, updated_at: doc.task.updated_at } : task);
      }
      renderPath();renderTasks();hideGuard();updateDirty();
      message('已读取任务文档。');
    } catch (error) {
      if (seq !== state.docSeq || projectId !== state.projectId) return;
      renderTasks();
      if (workspaceChanged(error)) { markWorkspaceChanged();message(WORKSPACE_STALE, true); }
      else message('读取任务文档失败：' + error.message, true);
    } finally {
      state.pendingDoc--;updateBusy();updateDirty();
    }
  }

  function requestProject(projectId) {
    if (state.saving || projectId === state.projectId) { renderProjects();return; }
    if (dirty()) { renderProjects();showGuard({ type: 'project', id: projectId });return; }
    void selectProject(projectId);
  }

  function requestTask(taskId) {
    if (state.saving || taskId === state.taskId) { renderTasks();return; }
    if (dirty()) { renderTasks();showGuard({ type: 'task', id: taskId });return; }
    if (!taskId) { resetDocument();return; }
    void openTask(taskId);
  }

  async function save() {
    if (!canEdit() || state.saving || !state.taskId) return;
    const content = read();
    const projectId = state.projectId;
    const taskId = state.taskId;
    const seq = ++state.docSeq;
    state.saving = true;updateBusy();updateDirty();message('正在保存…');
    try {
      const doc = await docApi('save_task', {
        project_id: projectId, task_id: taskId, content, revision: state.revision,
      });
      if (seq !== state.docSeq || state.taskId !== taskId) return;
      state.revision = doc.revision;state.baseline = doc.content;state.path = doc.path;
      if (doc.task) {
        state.tasks = state.tasks.map(task => task.id === taskId
          ? { ...task, title: doc.task.title, revision: doc.task.revision, updated_at: doc.task.updated_at } : task);
      }
      renderPath();renderTasks();hideGuard();message('已保存。');
    } catch (error) {
      // The draft is deliberately left untouched. Revision conflicts already
      // explain that the draft is retained and a re-read is required, so the
      // backend message is shown once instead of being duplicated here.
      if (workspaceChanged(error)) {
        markWorkspaceChanged();message(WORKSPACE_STALE, true);
      } else if (/重新读取|冲突|revision/i.test(error.message)) {
        message('保存冲突：' + error.message, true);
      } else {
        message('保存失败：' + error.message + ' 草稿仍保留在编辑器中，请稍后重试或重新读取。', true);
      }
    } finally {
      state.saving = false;updateBusy();updateDirty();
    }
  }

  function reloadTask() {
    if (!state.taskId || state.saving) return;
    if (dirty()) { showGuard({ type: 'reload' });return; }
    void openTask(state.taskId);
  }

  async function createProject(name) {
    if (!canEdit() || state.busyAdd) return;
    state.busyAdd = true;updateBusy();
    try {
      const data = await docApi('register_project', { name });
      if (!state.projects.some(project => project.id === data.project.id)) state.projects.push(data.project);
      state.projects.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
      $('sdd-project-name').value = '';
      renderProjects();
      await selectProject(data.project.id);
      message(data.created ? '项目已创建。' : '已有同名项目，已切换到该项目。');
    } catch (error) {
      if (workspaceChanged(error)) { markWorkspaceChanged();message(WORKSPACE_STALE, true); }
      else message('新建项目失败：' + error.message, true);
    } finally {
      state.busyAdd = false;updateBusy();
    }
  }

  function addProject() {
    if (!canEdit() || state.busyAdd) return;
    const name = $('sdd-project-name').value.trim();
    if (!name) { message('请输入项目名称。', true);return; }
    // Never create (or switch away) while the editor holds an unsaved draft.
    if (dirty()) { showGuard({ type: 'add_project', name });return; }
    void createProject(name);
  }

  function addWorkspace() {
    if (!canEdit() || state.busyWorkspace || state.saving) return;
    const directory = $('sdd-workspace-path').value.trim();
    if (!directory) { message('请输入 SDD 文档目录的绝对路径。', true);return; }
    if (!directory.startsWith('/')) { message('SDD 文档目录必须是绝对路径。', true);return; }
    // The workspace switch shares the same draft guard as every other switch:
    // cancelling never calls set_workspace.
    if (dirty()) { showGuard({ type: 'workspace', directory });return; }
    void applyWorkspace(directory);
  }

  async function createTask(title) {
    if (!canEdit() || state.busyTask) return;
    state.busyTask = true;updateBusy();
    try {
      const doc = await docApi('create_task', { project_id: state.projectId, title });
      $('sdd-task-title').value = '';
      state.taskId = doc.task.id;state.revision = doc.revision;state.baseline = doc.content;
      state.path = doc.path;editor().value = doc.content;
      state.tasks.unshift(doc.task);
      renderTasks();renderPath();hideGuard();updateDirty();
      message('任务已创建。');
    } catch (error) {
      if (workspaceChanged(error)) { markWorkspaceChanged();message(WORKSPACE_STALE, true); }
      else message('新建任务失败：' + error.message, true);
    } finally {
      state.busyTask = false;updateBusy();updateDirty();
    }
  }

  function addTask() {
    if (!canEdit() || state.busyTask) return;
    const title = $('sdd-task-title').value.trim();
    if (!state.projectId) { message('请先选择项目。', true);return; }
    if (!title) { message('请输入新任务标题。', true);return; }
    // Creating a task replaces the editor; guard the current draft first.
    if (dirty()) { showGuard({ type: 'add_task', title });return; }
    void createTask(title);
  }

  async function copyPath() {
    if (!state.path) return;
    try {
      await navigator.clipboard.writeText(state.path);
      message('路径已复制。');
    } catch {
      message('复制失败，请手动选择路径复制。', true);
    }
  }

  function discardAndRun(target) {
    hideGuard();
    // Creating a project/task must not be retried after "keep"; only an
    // explicit discard starts it. Failed creation keeps the draft unsaved.
    if (target.type === 'add_project') { void createProject(target.name);return; }
    if (target.type === 'add_task') { void createTask(target.title);return; }
    if (target.type === 'workspace') { void applyWorkspace(target.directory);return; }
    if (target.type === 'project') void selectProject(target.id);
    else if (target.type === 'task') void openTask(target.id);
    else if (target.type === 'reload') void openTask(state.taskId);
    else if (target.type === 'close') {
      editor().value = state.baseline;updateDirty();$('sdd').open = false;
    }
  }

  function onToggle() {
    const details = $('sdd');
    if (details.open) {
      if (!state.loaded) void loadProjects();
      return;
    }
    if (dirty()) {
      details.open = true;
      showGuard({ type: 'close' });
    }
  }

  function initialize() {
    if (state.initialized) return;
    state.initialized = true;
    if (!canEdit()) {
      $('sdd-note').textContent = READONLY;
      for (const id of ['sdd-workspace-path', 'sdd-workspace-apply', 'sdd-project', 'sdd-task',
        'sdd-project-name', 'sdd-project-add', 'sdd-task-title', 'sdd-task-add',
        'sdd-content', 'sdd-save', 'sdd-reload', 'sdd-copy']) {
        $(id).disabled = true;
      }
      message('共享任务文档的写操作仅在 Codex 看板中可用。');
      return;
    }
    $('sdd-note').textContent = DEFAULT_NOTE;
    $('sdd').addEventListener('toggle', onToggle);
    $('sdd-workspace-apply').addEventListener('click', addWorkspace);
    $('sdd-project').addEventListener('change', () => requestProject($('sdd-project').value));
    $('sdd-task').addEventListener('change', () => requestTask($('sdd-task').value));
    $('sdd-project-add').addEventListener('click', addProject);
    $('sdd-task-add').addEventListener('click', addTask);
    $('sdd-save').addEventListener('click', () => void save());
    $('sdd-reload').addEventListener('click', reloadTask);
    $('sdd-copy').addEventListener('click', () => void copyPath());
    $('sdd-content').addEventListener('input', updateDirty);
    $('sdd-guard-keep').addEventListener('click', () => {
      hideGuard();renderProjects();renderTasks();
      message('已保留未保存的修改。');
    });
    $('sdd-guard-discard').addEventListener('click', () => {
      const target = state.guard;
      if (target) discardAndRun(target);
    });
    updateBusy();updateDirty();renderPath();renderWorkspace();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();

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
    // The switch is persisted independently of the document workspace. It is
    // loaded on board start because it sits outside the collapsed section.
    enabled: true, stateKnown: false, configError: false,
    pendingState: false, toggleSaving: false,
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
  const disabledByServer = error => /SDD 任务文档已关闭|SDD 已关闭|SDD 工作区配置损坏|SDD 工作区配置无效/.test(error?.message ?? '');

  function message(text, error = false) {
    const node = $('sdd-message');
    if (!node) return;
    node.textContent = text;
    node.className = 'sdd-message' + (error ? ' error' : '');
  }

  function settingMessage(text, error = false) {
    const node = $('sdd-setting-message');
    if (!node) return;
    node.textContent = text;
    node.className = 'setting-message' + (error ? ' error' : '');
  }

  function renderEnabled() {
    $('sdd-switch').checked = state.enabled;
    $('sdd-state').textContent = !state.stateKnown
      ? state.configError ? '不可用' : '读取中'
      : state.enabled ? '已开启' : '已关闭';
    $('sdd-summary-meta').textContent = state.enabled
      ? '共享规划与验收约定'
      : '共享规划与验收约定 · 已关闭，已有文件保留';
    if (state.stateKnown && !state.enabled) {
      $('sdd-note').textContent = 'SDD 已关闭：不再自动生成或更新任务文档，已有文件与目录配置保留。重新开启后可继续编辑。';
    } else if (state.configError) {
      $('sdd-note').textContent = 'SDD 设置不可用：请先重新设置 SDD 文档目录。';
    } else {
      $('sdd-note').textContent = DEFAULT_NOTE;
    }
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
      || state.busyAdd || state.busyTask || state.busyWorkspace || state.pendingState;
    const disabled = !editable || busy;
    // Turning SDD off disables document operations only: the directory form and
    // the delegation switch stay usable, and existing files are left alone.
    const docDisabled = disabled || !state.enabled;
    $('sdd-switch').disabled = !editable || state.pendingState || state.toggleSaving || state.saving
      || state.configError || !state.stateKnown;
    $('sdd-workspace-path').disabled = disabled;
    $('sdd-workspace-apply').disabled = disabled;
    $('sdd-project').disabled = docDisabled || !state.projects.length;
    $('sdd-task').disabled = docDisabled || !state.projectId || !state.tasks.length;
    for (const id of ['sdd-project-name', 'sdd-project-add', 'sdd-task-title', 'sdd-task-add']) {
      $(id).disabled = docDisabled;
    }
    $('sdd-content').disabled = docDisabled || !state.taskId;
    $('sdd-save').disabled = docDisabled || !state.taskId;
    $('sdd-reload').disabled = docDisabled || !state.taskId;
    $('sdd-copy').disabled = docDisabled || !state.path;
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
      disable: ['关闭 SDD 任务文档', '放弃修改并关闭 SDD'],
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

  // The section and the always-visible switch both use this projection. The
  // switch is restored from get_workspace, so a reload (or another board) shows
  // the saved state instead of assuming ON.
  function applyState(data) {
    state.directory = data.directory ?? state.directory;
    state.workspaceId = data.workspace_id ?? state.workspaceId;
    state.enabled = data.enabled !== false;
    state.stateKnown = true;
    state.configError = false;
    renderWorkspace();
    renderEnabled();
  }

  async function loadState() {
    if (!canEdit()) return;
    state.pendingState = true;updateBusy();
    try {
      const data = await api('get_workspace');
      applyState(data);
      settingMessage(state.enabled
        ? '关闭后不生成或更新文档，已有文件与目录配置保留。'
        : 'SDD 已关闭：不会自动生成或更新文档，已有文件与目录配置保留。');
    } catch (error) {
      // A damaged settings file is reported instead of being shown as enabled;
      // the directory form below can repair it.
      state.stateKnown = false;state.configError = true;state.enabled = false;
      renderEnabled();
      settingMessage('读取 SDD 设置失败：' + error.message + ' 请先在看板中重新设置 SDD 文档目录。', true);
      message('读取 SDD 设置失败：' + error.message, true);
    } finally {
      state.pendingState = false;updateBusy();updateDirty();
    }
  }

  async function applyEnabled(enabled) {
    if (!canEdit() || state.toggleSaving) return;
    state.toggleSaving = true;updateBusy();
    settingMessage(enabled ? '正在开启 SDD 任务文档…' : '正在关闭 SDD 任务文档…');
    try {
      const data = await api('set_enabled', { enabled });
      applyState(data);
      if (!state.enabled) {
        // The editor keeps the last saved text read-only; files stay untouched.
        if (state.taskId) editor().value = state.baseline;
        updateDirty();
        settingMessage('SDD 已关闭：不会自动生成或更新文档，已有文件与目录配置保留。');
        message('已关闭 SDD 任务文档；已有文档和目录配置保留。');
      } else {
        settingMessage('SDD 已开启：派工前可保存任务约定。');
        message('已开启 SDD 任务文档。');
        state.loaded = false;
        if ($('sdd').open) await loadProjects();
      }
    } catch (error) {
      // The switch is rolled back to the last confirmed state, and the error is
      // readable instead of leaving the UI disagreeing with storage.
      renderEnabled();
      settingMessage('切换 SDD 开关失败：' + error.message, true);
      message('切换 SDD 开关失败：' + error.message, true);
    } finally {
      state.toggleSaving = false;updateBusy();updateDirty();
    }
  }

  function requestEnabled() {
    if (!canEdit() || state.toggleSaving) { renderEnabled();return; }
    const next = $('sdd-switch').checked;
    if (next === state.enabled) return;
    if (!next) {
      // Turning SDD off does not clear an unsaved draft silently: the user must
      // keep editing (and stay ON) or explicitly discard before it turns off.
      if (dirty()) {
        renderEnabled();
        showGuard({ type: 'disable' });
        return;
      }
      void applyEnabled(false);
      return;
    }
    void applyEnabled(true);
  }

  async function applyWorkspace(directory) {
    if (!canEdit() || state.busyWorkspace) return;
    if (state.saving) { message('正在保存，请稍后再切换 SDD 文档目录。', true);return; }
    // Any in-flight response now belongs to the previous document set.
    state.listSeq++;state.tasksSeq++;state.docSeq++;
    state.busyWorkspace = true;updateBusy();message('正在切换 SDD 文档目录…');
    try {
      const data = await api('set_workspace', { directory });
      applyState(data);
      $('sdd-workspace-path').value = '';
      // A different workspace is a different document set: the old selection is
      // cleared and the old directory is left untouched on disk.
      clearSelection();
      state.loaded = false;
      if (!state.enabled) {
        message(`SDD 文档目录已切换为 ${state.directory}。SDD 当前关闭，不会自动写文档；原目录文件保留。`);
        return;
      }
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
    if (!canEdit() || !state.enabled) return false;
    const seq = ++state.listSeq;
    state.pendingProjects++;updateBusy();
    let ok = false;
    try {
      const workspace = await api('get_workspace');
      if (seq !== state.listSeq) return false;
      state.directory = workspace.directory ?? '';
      state.workspaceId = workspace.workspace_id ?? '';
      // Another board may have switched SDD off since this page loaded.
      state.enabled = workspace.enabled !== false;
      state.stateKnown = true;state.configError = false;
      renderWorkspace();renderEnabled();
      if (!state.enabled) {
        message('SDD 已在其他看板关闭，本轮不会读取或写入文档；已有文件保留。', true);
        updateBusy();
        return false;
      }
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
      else if (disabledByServer(error)) { message('SDD 设置已变化：' + error.message, true);void loadState(); }
      else message('读取 SDD 工作区失败：' + error.message, true);
    } finally {
      state.pendingProjects--;updateBusy();
    }
    if (ok && state.projectId && !state.tasks.length) await loadTasks();
    return ok;
  }

  async function loadTasks() {
    if (!canEdit() || !state.projectId || !state.enabled) return;
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
      else if (disabledByServer(error)) { message('SDD 设置已变化：' + error.message, true);void loadState(); }
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
    if (!state.enabled) { message('SDD 已关闭，无法读取或更新文档。', true);return; }
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
      else if (disabledByServer(error)) { message('SDD 设置已变化：' + error.message, true);void loadState(); }
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
    if (!state.enabled) { message('SDD 已关闭，无法保存文档。请先在看板开启 SDD。', true);void loadState();return; }
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
      } else if (disabledByServer(error)) {
        // Another board turned SDD off: keep the draft, stop writing, and sync
        // the switch so this page no longer claims document writes are open.
        message('SDD 已被关闭：' + error.message + ' 未保存的草稿仍保留在编辑器中。', true);
        void loadState();
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
    if (!state.enabled) { message('SDD 已关闭，无法新建项目。请先在看板开启 SDD。', true);return; }
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
      else if (disabledByServer(error)) { message('SDD 已被关闭：' + error.message, true);void loadState(); }
      else message('新建项目失败：' + error.message, true);
    } finally {
      state.busyAdd = false;updateBusy();
    }
  }

  function addProject() {
    if (!canEdit() || state.busyAdd) return;
    if (!state.enabled) { message('SDD 已关闭，无法新建项目。', true);return; }
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
    if (!state.enabled) { message('SDD 已关闭，无法新建任务文档。请先在看板开启 SDD。', true);return; }
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
      else if (disabledByServer(error)) { message('SDD 已被关闭：' + error.message, true);void loadState(); }
      else message('新建任务失败：' + error.message, true);
    } finally {
      state.busyTask = false;updateBusy();updateDirty();
    }
  }

  function addTask() {
    if (!canEdit() || state.busyTask) return;
    if (!state.enabled) { message('SDD 已关闭，无法新建任务文档。', true);return; }
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
    if (target.type === 'disable') {
      // Discarding restores the last saved text before the switch turns off; the
      // file itself was never touched by the unsaved draft.
      editor().value = state.baseline;updateDirty();void applyEnabled(false);return;
    }
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
      if (!state.enabled) {
        message('SDD 已关闭：不会读取或写入文档。开启后可继续编辑。');
        return;
      }
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
      // The read-only HTTP monitor shows the switch but cannot change it.
      $('sdd-note').textContent = READONLY;
      $('sdd-state').textContent = '只读';
      $('sdd-switch').disabled = true;
      settingMessage('SDD 开关与文档写入仅可在 Codex 看板中设置。');
      for (const id of ['sdd-workspace-path', 'sdd-workspace-apply', 'sdd-project', 'sdd-task',
        'sdd-project-name', 'sdd-project-add', 'sdd-task-title', 'sdd-task-add',
        'sdd-content', 'sdd-save', 'sdd-reload', 'sdd-copy']) {
        $(id).disabled = true;
      }
      message('共享任务文档的写操作仅在 Codex 看板中可用。');
      return;
    }
    $('sdd-note').textContent = DEFAULT_NOTE;
    // The switch sits outside the collapsed section, so its saved state is read
    // on board start without loading the project/task lists (kept lazy).
    $('sdd-switch').addEventListener('change', requestEnabled);
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
    renderEnabled();renderPath();renderWorkspace();updateBusy();updateDirty();
    void loadState();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

// Lightweight SDD documents. The board first selects a shared document
// workspace (a plain directory, home/sdd by default); projects only classify
// documents, and every task owns exactly one plain Markdown file. Neither the
// code project nor any other file in the workspace is read, scanned or written:
// only project folders owned by this plugin are touched.
export const MAX_DOC_BYTES = 256 * 1024;
export const WORKSPACE_FILE = 'sdd-workspace.json';
const DEFAULT_DIRECTORY = 'sdd';
const LOCK_TIMEOUT_MS = 3000;
const LOCK_STALE_MS = 60_000;
const PROJECT_ID = /^[a-f0-9]{16}$/;
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKSPACE_ID = /^[a-f0-9]{16}$/;
const PROJECT_META_BYTES = 64 * 1024;
const WORKSPACE_BYTES = 64 * 1024;

const projectId = z.string().regex(PROJECT_ID, '项目编号无效。');
const taskId = z.string().regex(TASK_ID, '任务编号无效。');
const workspaceId = z.string().regex(WORKSPACE_ID, 'SDD 工作区标识无效，请重新读取工作区。');
const directory = z.string().trim().min(1, 'SDD 文档目录不能为空。').max(4096, 'SDD 文档目录过长。');
const projectName = z.string().trim().min(1, '项目名称不能为空。').max(120, '项目名称不能超过 120 个字符。')
  .refine(value => !/[\r\n]/.test(value), '项目名称不能包含换行。');
const title = z.string().trim().min(1, '标题不能为空。').max(120, '标题不能超过 120 个字符。')
  .refine(value => !/[\r\n]/.test(value), '标题不能包含换行。');
const revision = z.string().regex(/^[a-f0-9]{64}$/, '文档版本无效，请重新读取。');

export const sddSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('get_workspace') }).strict(),
  z.object({ action: z.literal('set_workspace'), directory }).strict(),
  // The document switch is a board-only setting. The model-facing sdd_task
  // schema deliberately omits this action; writes are refused while it is off.
  z.object({ action: z.literal('set_enabled'), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('list_projects'), workspace_id: workspaceId }).strict(),
  z.object({ action: z.literal('register_project'), workspace_id: workspaceId, name: projectName }).strict(),
  z.object({ action: z.literal('list_tasks'), workspace_id: workspaceId, project_id: projectId }).strict(),
  // The board still creates the legacy template from a title. A caller that
  // already has a complete plan supplies content instead; it is validated and
  // written as the one atomic task.md creation, never as a placeholder.
  z.object({
    action: z.literal('create_task'), workspace_id: workspaceId, project_id: projectId,
    title: title.optional(), content: z.string().optional(),
  }).strict()
    .refine(value => value.title !== undefined || value.content !== undefined, '创建任务需要标题或完整正文。')
    .refine(value => value.content === undefined || value.content.trim().length > 0, '任务正文不能为空。'),
  z.object({ action: z.literal('read_task'), workspace_id: workspaceId, project_id: projectId, task_id: taskId }).strict(),
  z.object({
    action: z.literal('save_task'), workspace_id: workspaceId, project_id: projectId, task_id: taskId,
    content: z.string(), revision,
  }).strict(),
]);

// Legacy metadata stored {name, path} where path was a code directory. The path
// is kept only so old project folders stay readable; it is never read, shown or
// accessed as a document location, and data is never migrated destructively.
const projectMetaSchema = z.object({
  name: z.string().trim().min(1).max(120),
  path: z.string().max(4096).optional(),
}).strict();

// Legacy settings stored only {directory}; a missing `enabled` keeps the old
// automatic behavior (ON). New writes may store either field, so turning the
// switch on a fresh install never has to persist or create the default root.
const workspaceSchema = z.object({
  directory: z.string().max(4096).refine(isAbsolute, 'SDD 文档目录必须是绝对路径。').optional(),
  enabled: z.boolean().optional(),
}).strict().refine(value => value.directory !== undefined || value.enabled !== undefined,
  'SDD 工作区配置无效。');
const WRITE_ACTIONS = new Set(['register_project', 'create_task', 'save_task']);
const SDD_DISABLED_MESSAGE = 'SDD 任务文档已关闭，未写入或创建任何文档。请由用户在 Agents 看板开启 SDD 后再操作。';

export class SddError extends Error {
  constructor(message, code = 'SDD_ERROR') {
    super(message);
    this.name = 'SddError';
    this.code = code;
  }
}

const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const workspaceDigest = directory => digest(`sdd-workspace\0${directory}`).slice(0, 16);
// A project is classified by its name only, so its folder ID is derived from
// the normalized name. Concurrent registrations of the same name therefore
// address the same folder and can never create a duplicate category.
const projectDigest = name => digest(`sdd-project\0${name}`).slice(0, 16);
const normalizeName = name => name.normalize('NFC');
const taskTemplate = name => `# ${name}\n\n## 目标\n\n待填写：要解决的问题与期望结果。\n\n## 范围\n\n待填写：允许修改的文件或目录；明确不做的事项。\n\n## 计划\n\n1. 待填写\n\n## 验收条件\n\n- [ ] 待填写\n`;
const taskTitle = content => /^#\s+(.+?)\s*$/m.exec(content.slice(0, 8192))?.[1]?.trim().slice(0, 120) || '未命名任务';
const lstatOrNull = async path => {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null;throw error; }
};

// Stable identity for a directory that may not exist yet: canonicalize the
// closest existing ancestor and append the remaining names. Reading the default
// root therefore keeps the same workspace ID before and after the first write
// without creating the directory as a side effect.
async function canonicalPath(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) return path;
    return join(await canonicalPath(parent), basename(path));
  }
}

const processAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0);return true; }
  catch (error) { return error.code === 'EPERM'; }
};

async function readLock(lock, unsafePath = '锁路径不安全。') {
  const info = await lstatOrNull(lock);
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isFile()) throw new SddError(unsafePath, 'UNSAFE_PATH');
  if (info.size > 4096) return { corrupt: true, info };
  try { return { ...JSON.parse(await readFile(lock, 'utf8')), info }; }
  catch { return { corrupt: true, info }; }
}

async function atomicWrite(path, content) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function readProjectMeta(directory) {
  const file = join(directory, 'project.json');
  const info = await lstatOrNull(file);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > PROJECT_META_BYTES) return null;
  let value;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch { return null; }
  const parsed = projectMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// Another process (one that predates the registration lock) may be between
// mkdir and the metadata rename; wait briefly for that window instead of
// treating the folder as foreign. The parent is re-checked every round so a
// symlinked project folder is never followed to read metadata outside the
// workspace.
async function waitForProjectMeta(directory, timeout = 500) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const info = await lstatOrNull(directory);
    if (info && (info.isSymbolicLink() || !info.isDirectory())) {
      throw new SddError('项目目录无效或是不安全的符号链接，已停止。', 'UNSAFE_PATH');
    }
    const meta = await readProjectMeta(directory);
    if (meta) return meta;
    if (Date.now() >= deadline) return null;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

function projectView(id, meta, root) {
  return { id, name: meta.name, path: join(root, id) };
}

function documentView(task, project, document) {
  return {
    project,
    task: {
      id: task.id, title: taskTitle(document.content), path: document.file,
      revision: document.revision, size: document.bytes, updated_at: document.info.mtime.toISOString(),
    },
    content: document.content,
    revision: document.revision,
    path: document.file,
  };
}

export class SddWorkspace {
  constructor(home) {
    if (typeof home !== 'string' || !isAbsolute(home)) throw new SddError('数据目录必须是绝对路径。', 'INVALID_HOME');
    this.home = resolve(home);
  }

  // Raw settings read that never throws for a missing or damaged file. Reads
  // report damage instead of falling back; the repair path needs to know which
  // case it is so a missing file keeps the legacy ON default while a damaged
  // file is never silently treated as enabled.
  async #readConfig() {
    const file = join(this.home, WORKSPACE_FILE);
    const info = await lstatOrNull(file);
    if (!info) return { kind: 'missing' };
    if (info.isSymbolicLink() || !info.isFile()) throw new SddError('SDD 工作区配置路径不安全。', 'UNSAFE_PATH');
    if (info.size > WORKSPACE_BYTES) return { kind: 'invalid' };
    let value;
    try { value = JSON.parse(await readFile(file, 'utf8')); }
    catch { return { kind: 'corrupt' }; }
    const parsed = workspaceSchema.safeParse(value);
    if (!parsed.success) return { kind: 'invalid' };
    return {
      kind: 'valid',
      directory: resolve(parsed.data.directory ?? join(this.home, DEFAULT_DIRECTORY)),
      configured: parsed.data.directory !== undefined,
      // Old settings predate the switch: keep them ON as before.
      enabled: parsed.data.enabled ?? true,
    };
  }

  // The configured workspace (home/sdd when nothing is configured yet). Reading
  // an invalid configuration is an error: it never silently falls back to the
  // default directory, so documents can never be written to an unexpected root.
  async #config() {
    const raw = await this.#readConfig();
    if (raw.kind === 'missing') {
      return { directory: resolve(join(this.home, DEFAULT_DIRECTORY)), configured: false, enabled: true };
    }
    if (raw.kind === 'corrupt') throw new SddError(`SDD 工作区配置损坏：${WORKSPACE_FILE} 不是有效 JSON。`, 'INVALID_WORKSPACE');
    if (raw.kind === 'invalid') {
      throw new SddError(`SDD 工作区配置无效：${WORKSPACE_FILE} 需要 {directory: 绝对目录, enabled?: 布尔}。`, 'INVALID_WORKSPACE');
    }
    return raw;
  }

  // Resolve the workspace once per action call. Every later step receives this
  // captured root, so a configuration switch in another board cannot make one
  // call read and write under different roots. Reads never create the default
  // root; `create` is only used by document-write actions.
  async #openWorkspace({ config: provided, create = false } = {}) {
    const config = provided ?? await this.#config();
    let info = await lstatOrNull(config.directory);
    if (!info) {
      if (config.configured) throw new SddError('SDD 文档目录不存在，请检查工作区设置。', 'INVALID_WORKSPACE');
      const directory = await canonicalPath(config.directory);
      if (!create) return { directory, id: workspaceDigest(directory), default: true, configured: false, enabled: config.enabled, exists: false };
      // The default home/sdd is created lazily on the first document write. An
      // explicitly configured directory is created by set_workspace instead.
      await mkdir(config.directory, { recursive: true, mode: 0o700 });
      info = await lstat(config.directory);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new SddError('SDD 文档目录不可用，请检查工作区设置。', 'INVALID_WORKSPACE');
    }
    const directory = await realpath(config.directory);
    return { directory, id: workspaceDigest(directory), default: !config.configured, configured: config.configured, enabled: config.enabled, exists: true };
  }

  async getWorkspace() {
    const workspace = await this.#openWorkspace();
    return {
      directory: workspace.directory, workspace_id: workspace.id, default: workspace.default,
      configured: workspace.configured, enabled: workspace.enabled,
    };
  }

  // Lightweight current state for the Hook and for restoring the board switch.
  // This never creates the default root and never touches a document.
  async state() {
    const config = await this.#config();
    const directory = await canonicalPath(config.directory);
    return {
      directory, workspace_id: workspaceDigest(directory), default: !config.configured,
      configured: config.configured, enabled: config.enabled,
    };
  }

  // The board switch is the only writer. It shares the configuration lock with
  // set_workspace so a read-modify-write of one setting can never persist a
  // stale copy of the other.
  async setEnabled({ enabled }) {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    return this.#withConfigLock(async () => {
      const raw = await this.#readConfig();
      if (raw.kind !== 'valid' && raw.kind !== 'missing') {
        throw new SddError('SDD 工作区配置损坏或无效，无法保存开关。请先在看板中重新设置 SDD 文档目录。', 'INVALID_WORKSPACE');
      }
      const config = raw.kind === 'valid'
        ? raw : { directory: resolve(join(this.home, DEFAULT_DIRECTORY)), configured: false, enabled: true };
      const directory = await canonicalPath(config.directory);
      // A damaged configured root is still reported by get_workspace; the
      // switch itself can always be saved so the user can stop automatic writes.
      const next = { ...(config.configured ? { directory } : {}), enabled };
      await atomicWrite(join(this.home, WORKSPACE_FILE), JSON.stringify(next, null, 2) + '\n');
      return {
        directory, workspace_id: workspaceDigest(directory), default: !config.configured,
        configured: config.configured, enabled, changed: config.enabled !== enabled,
      };
    });
  }

  async setWorkspace({ directory: path }) {
    const raw = path.trim();
    if (!isAbsolute(raw)) throw new SddError('SDD 文档目录必须是绝对路径。', 'INVALID_PATH');
    const target = resolve(raw);
    let created = false;
    try {
      if (!await lstatOrNull(target)) {
        // An explicitly set directory may be created, but nothing inside it is
        // touched beyond the project folders this plugin owns.
        await mkdir(target, { recursive: true, mode: 0o700 });
        created = true;
      }
    } catch (error) { throw new SddError('无法创建 SDD 文档目录：' + error.message, 'INVALID_PATH'); }
    let real;
    try { real = await realpath(target); }
    catch (error) { throw new SddError('SDD 文档目录不可用：' + error.message, 'INVALID_PATH'); }
    if (!(await stat(real)).isDirectory()) throw new SddError('SDD 文档目录必须是目录。', 'INVALID_PATH');
    try { await access(real, constants.W_OK); }
    catch { throw new SddError('SDD 文档目录不可写。', 'INVALID_PATH'); }
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    return this.#withConfigLock(async () => {
      // A damaged configuration must not block repairing it by setting a new
      // directory; reads still report the damage instead of switching silently.
      // Repairing a damaged file keeps SDD OFF (never defaulting to auto-write),
      // while a missing file keeps the legacy ON default.
      const previous = await this.#readConfig();
      const enabled = previous.kind === 'valid' ? previous.enabled : previous.kind === 'missing';
      const previousDirectory = previous.kind === 'valid' && previous.configured ? previous.directory : null;
      const alreadyConfigured = previousDirectory === real;
      const changed = !alreadyConfigured;
      if (changed) {
        // Even when the chosen directory is the default one, writing the setting
        // keeps the returned state identical to a later get_workspace call.
        await atomicWrite(join(this.home, WORKSPACE_FILE), JSON.stringify({ directory: real, enabled }, null, 2) + '\n');
      }
      return { directory: real, workspace_id: workspaceDigest(real), default: false, configured: true, enabled, changed, created };
    });
  }

  async #findProjectsByName(root, name) {
    const entries = await readdir(root, { withFileTypes: true });
    const found = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !PROJECT_ID.test(entry.name)) continue;
      const candidate = join(root, entry.name);
      const info = await lstatOrNull(candidate);
      if (!info?.isDirectory() || info.isSymbolicLink()) continue;
      const meta = await readProjectMeta(candidate);
      if (meta && normalizeName(meta.name) === name) found.push({ id: entry.name, directory: candidate, meta });
    }
    found.sort((left, right) => left.id.localeCompare(right.id));
    return found;
  }

  async #project(workspace, project_id) {
    if (!PROJECT_ID.test(project_id)) throw new SddError('项目编号无效。', 'INVALID_ID');
    const root = workspace.directory;
    const directory = join(root, project_id);
    const info = await lstatOrNull(directory);
    if (!info) throw new SddError('项目不存在。', 'PROJECT_NOT_FOUND');
    if (info.isSymbolicLink() || !info.isDirectory()) throw new SddError('项目目录无效。', 'UNSAFE_PATH');
    const meta = await readProjectMeta(directory);
    if (!meta) throw new SddError('项目元数据缺失或损坏。', 'PROJECT_INVALID');
    return { root, directory, meta, view: projectView(project_id, meta, root) };
  }

  async #taskDirectory(projectDirectory, task_id) {
    if (!TASK_ID.test(task_id)) throw new SddError('任务编号无效。', 'INVALID_ID');
    const directory = join(projectDirectory, task_id);
    const info = await lstatOrNull(directory);
    if (!info) throw new SddError('任务不存在。', 'TASK_NOT_FOUND');
    if (info.isSymbolicLink() || !info.isDirectory()) throw new SddError('任务目录无效。', 'UNSAFE_PATH');
    return directory;
  }

  async #document(taskDirectory) {
    const file = join(taskDirectory, 'task.md');
    const info = await lstatOrNull(file);
    if (!info) throw new SddError('任务文档不存在。', 'TASK_NOT_FOUND');
    if (info.isSymbolicLink() || !info.isFile()) throw new SddError('任务文档路径不安全。', 'UNSAFE_PATH');
    if (info.size > MAX_DOC_BYTES) throw new SddError('任务文档超过 256 KiB 上限。', 'DOC_TOO_LARGE');
    const content = await readFile(file, 'utf8');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_DOC_BYTES) throw new SddError('任务文档超过 256 KiB 上限。', 'DOC_TOO_LARGE');
    return { file, content, bytes, revision: digest(content), info };
  }

  // Cross-process exclusive lock. For documents the revision is re-read inside
  // the lock, so two concurrent saves of the same revision can never both
  // succeed, even from separate Node processes. Project registration uses the
  // same lock so the name -> folder decision is serialized inside one root.
  async #withLock(lock, { unsafePath, busy, busyCode }, action) {
    const owner = randomUUID();
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        await writeFile(lock, JSON.stringify({ pid: process.pid, owner, at: Date.now() }), { flag: 'wx', mode: 0o600 });
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const held = await readLock(lock, unsafePath);
        if (!held) continue;
        const stale = held.corrupt
          ? Boolean(held.info && Date.now() - held.info.mtimeMs > LOCK_STALE_MS)
          : !processAlive(held.pid);
        if (stale) { await rm(lock, { force: true });continue; }
        if (Date.now() >= deadline) throw new SddError(busy, busyCode);
        await new Promise(resolve => setTimeout(resolve, 15));
      }
    }
    try { return await action(); }
    finally {
      const held = await readLock(lock, unsafePath).catch(() => null);
      if (held && !held.corrupt && held.owner === owner) await rm(lock, { force: true }).catch(() => {});
    }
  }

  async #withDocumentLock(taskDirectory, action) {
    return this.#withLock(join(taskDirectory, '.task.md.lock'), {
      unsafePath: '任务文档锁路径不安全。',
      busy: '任务文档正在被其他进程保存，请稍后重试。', busyCode: 'DOC_BUSY',
    }, action);
  }

  async #withRegistrationLock(root, action) {
    return this.#withLock(join(root, '.projects.lock'), {
      unsafePath: '项目登记锁路径不安全，请检查 SDD 文档目录。',
      busy: '项目登记正在被其他看板或进程进行，请稍后重试。', busyCode: 'REGISTRY_BUSY',
    }, action);
  }

  // One cross-process lock for the whole settings file. set_workspace and
  // set_enabled both read-modify-write it, so sharing this lock is what stops a
  // directory change from overwriting a concurrent switch change (or vice
  // versa). Document writes also hold it while they re-check the switch, so a
  // concurrent board cannot turn SDD off in the middle of an accepted write.
  async #withConfigLock(action) {
    return this.#withLock(join(this.home, '.sdd-workspace.lock'), {
      unsafePath: 'SDD 配置锁路径不安全。',
      busy: 'SDD 设置正在被其他看板保存，请稍后重试。', busyCode: 'CONFIG_BUSY',
    }, action);
  }

  async listProjects(workspace) {
    // The default root is not created by a read; a fresh install simply lists
    // no projects until the first document write creates the home/sdd folder.
    if (!workspace.exists) return { projects: [] };
    const root = workspace.directory;
    const entries = await readdir(root, { withFileTypes: true });
    const projects = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !PROJECT_ID.test(entry.name)) continue;
      const directory = join(root, entry.name);
      const info = await lstatOrNull(directory);
      if (!info?.isDirectory() || info.isSymbolicLink()) continue;
      const meta = await readProjectMeta(directory);
      if (meta) projects.push(projectView(entry.name, meta, root));
    }
    projects.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    return { projects };
  }

  // Projects are only a classification inside the shared document workspace.
  // The folder ID is derived from the normalized name, so concurrent boards
  // registering the same name address the same folder and the name never
  // appears twice. The decision runs under a per-root cross-process lock;
  // existing folders (legacy or not) are never overwritten or deleted.
  async registerProject(workspace, { name }) {
    const root = workspace.directory;
    const projectName = normalizeName(name);
    return this.#withRegistrationLock(root, async () => {
      const existing = (await this.#findProjectsByName(root, projectName))[0];
      if (existing) return { project: projectView(existing.id, existing.meta, root), created: false };
      const id = projectDigest(projectName);
      const projectDirectory = join(root, id);
      const occupied = await lstatOrNull(projectDirectory);
      let created = false;
      if (occupied) {
        // Never take over a folder that already exists: another process may be
        // finishing its metadata write, and a visible folder could already hold
        // task documents. Wait out the write window, then report the conflict.
        const meta = await waitForProjectMeta(projectDirectory);
        if (meta && normalizeName(meta.name) === projectName) {
          return { project: projectView(id, meta, root), created: false };
        }
        throw new SddError('项目目录已存在但元数据缺失或不匹配，为避免覆盖已有内容已停止。请检查该目录。', 'PROJECT_CONFLICT');
      }
      try { await mkdir(projectDirectory, { mode: 0o700 });created = true; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // A process outside this lock won the mkdir race; reuse its metadata.
        const meta = await waitForProjectMeta(projectDirectory);
        if (meta && normalizeName(meta.name) === projectName) {
          return { project: projectView(id, meta, root), created: false };
        }
        throw new SddError('项目目录已存在但元数据缺失或不匹配，为避免覆盖已有内容已停止。请检查该目录。', 'PROJECT_CONFLICT');
      }
      const meta = { name: projectName };
      try { await atomicWrite(join(projectDirectory, 'project.json'), JSON.stringify(meta, null, 2) + '\n'); }
      catch (error) {
        // Leave the freshly created folder in place (a folder without metadata
        // is never listed) instead of deleting anything that may already exist.
        throw new SddError('项目元数据写入失败：' + error.message, 'PROJECT_INVALID');
      }
      return { project: projectView(id, meta, root), created };
    });
  }

  async listTasks(workspace, { project_id }) {
    const { directory, view } = await this.#project(workspace, project_id);
    const entries = await readdir(directory, { withFileTypes: true });
    const tasks = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !TASK_ID.test(entry.name)) continue;
      const taskDirectory = join(directory, entry.name);
      const info = await lstatOrNull(taskDirectory);
      if (!info?.isDirectory() || info.isSymbolicLink()) continue;
      try {
        const document = await this.#document(taskDirectory);
        tasks.push({
          id: entry.name, title: taskTitle(document.content), path: document.file,
          revision: document.revision, size: document.bytes, updated_at: document.info.mtime.toISOString(),
        });
      } catch { /* A broken task must not make the whole list unreadable. */ }
    }
    tasks.sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id));
    return { project: view, tasks };
  }

  async createTask(workspace, { project_id, title: name, content }) {
    const { directory, view } = await this.#project(workspace, project_id);
    // Validate the complete body before creating the task folder: a rejected
    // size or an empty model body must leave no new task directory behind.
    const body = content ?? taskTemplate(name);
    if (content !== undefined && !content.trim()) throw new SddError('任务正文不能为空。', 'EMPTY_DOCUMENT');
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > MAX_DOC_BYTES) throw new SddError('任务文档超过 256 KiB 上限。', 'DOC_TOO_LARGE');
    const id = randomUUID();
    const taskDirectory = join(directory, id);
    await mkdir(taskDirectory, { mode: 0o700 });
    const file = join(taskDirectory, 'task.md');
    try { await atomicWrite(file, body); }
    catch (error) {
      await rm(taskDirectory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    const info = await stat(file);
    return documentView({ id }, view, { file, content: body, bytes, revision: digest(body), info });
  }

  async readTask(workspace, { project_id, task_id }) {
    const { directory, view } = await this.#project(workspace, project_id);
    const taskDirectory = await this.#taskDirectory(directory, task_id);
    return documentView({ id: task_id }, view, await this.#document(taskDirectory));
  }

  async saveTask(workspace, { project_id, task_id, content, revision: expected }) {
    const { directory, view } = await this.#project(workspace, project_id);
    const taskDirectory = await this.#taskDirectory(directory, task_id);
    if (Buffer.byteLength(content, 'utf8') > MAX_DOC_BYTES) throw new SddError('任务文档超过 256 KiB 上限。', 'DOC_TOO_LARGE');
    return this.#withDocumentLock(taskDirectory, async () => {
      // Re-read inside the cross-process lock so a second writer that also saw
      // the old revision is rejected instead of silently winning.
      const current = await this.#document(taskDirectory);
      if (current.revision !== expected) {
        throw new SddError('文档已在别处修改。请重新读取后再保存，未保存的草稿仍保留在编辑器中。', 'REVISION_CONFLICT');
      }
      await atomicWrite(current.file, content);
      const info = await stat(current.file);
      return documentView({ id: task_id }, view, {
        file: current.file, content, bytes: Buffer.byteLength(content, 'utf8'), revision: digest(content), info,
      });
    });
  }

  #dispatch(workspace, parsed) {
    switch (parsed.action) {
      case 'list_projects': return this.listProjects(workspace);
      case 'register_project': return this.registerProject(workspace, parsed);
      case 'list_tasks': return this.listTasks(workspace, parsed);
      case 'create_task': return this.createTask(workspace, parsed);
      case 'read_task': return this.readTask(workspace, parsed);
      case 'save_task': return this.saveTask(workspace, parsed);
      default: throw new SddError('不支持的文档操作。', 'INVALID_ACTION');
    }
  }

  async action(input) {
    const parsed = sddSchema.parse(input);
    if (parsed.action === 'get_workspace') return this.getWorkspace();
    if (parsed.action === 'set_workspace') return this.setWorkspace(parsed);
    if (parsed.action === 'set_enabled') return this.setEnabled(parsed);
    if (WRITE_ACTIONS.has(parsed.action)) {
      // The switch check and the document write share the settings lock, so a
      // concurrent board that turns SDD off either completes before this write
      // (which is then rejected) or starts after it (which is then allowed).
      // Reading the switch outside the lock could let one write slip through.
      await mkdir(this.home, { recursive: true, mode: 0o700 });
      return this.#withConfigLock(async () => {
        // A damaged configuration throws here instead of defaulting to ON, so
        // automatic writes can never happen behind an unreadable switch.
        const config = await this.#config();
        if (!config.enabled) throw new SddError(SDD_DISABLED_MESSAGE, 'SDD_DISABLED');
        const workspace = await this.#openWorkspace({ config, create: parsed.action !== 'save_task' });
        if (parsed.workspace_id !== workspace.id) {
          throw new SddError('SDD 工作区已切换，请重新读取工作区后再操作；未保存的草稿仍保留在编辑器中。', 'WORKSPACE_CHANGED');
        }
        return this.#dispatch(workspace, parsed);
      });
    }
    // Capture the root + identifier once; every step below uses this snapshot so
    // a workspace switch mid-call can never split a read from its write.
    const workspace = await this.#openWorkspace();
    if (parsed.workspace_id !== workspace.id) {
      throw new SddError('SDD 工作区已切换，请重新读取工作区后再操作；未保存的草稿仍保留在编辑器中。', 'WORKSPACE_CHANGED');
    }
    return this.#dispatch(workspace, parsed);
  }
}

// Hook-facing state read. It never creates the default root, never writes, and
// reports a damaged configuration as disabled instead of defaulting to ON.
export async function readSddState(home) {
  try {
    return await new SddWorkspace(home).state();
  } catch (error) {
    return { enabled: false, error: error.message };
  }
}

export async function runSddAction(home, input) {
  return new SddWorkspace(home).action(input);
}

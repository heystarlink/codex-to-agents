import { mkdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

// DSH's base profile configures these three presets as one sandbox mode plus
// one approval policy each. The adapter only maps the user's saved preference
// onto that native table; omitting the field follows whatever default DSH pins
// for a fresh session. Keeping the list here leaves the installed runtime
// snapshot self-contained (only desktop.mjs and its siblings are copied there).
export const DSH_PERMISSION_PRESETS = Object.freeze(['read-only', 'workspace-write', 'danger-full-access']);
const DSH_PERMISSION_LABELS = Object.freeze({
  'read-only': '仅可查看', 'workspace-write': '工作区内修改', 'danger-full-access': '完全权限',
});
export const dshPermissionName = name => DSH_PERMISSION_LABELS[name] ?? name;

function claimedMessage(events, orderId) {
  const inboxes = new Map();let claimed;
  const matches = message => message.source?.rpcId === orderId;
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue;
    const data = event.data;
    const queue = inboxes.get(data.target) ?? [];inboxes.set(data.target, queue);
    const inserted = data.inserted ?? [];
    const removed = queue.splice(data.start, data.removedCount ?? 0, ...inserted);
    if (removed.some(matches)) claimed = event;
    if (inserted.some(matches)) claimed = undefined;
  }
  return claimed;
}

// Only this adapter knows DSH service names. Queue and MCP code know work orders.
export class Desktop {
  constructor(context, settings) {
    this.context = context;
    this.settings = settings;
    const providers = settings.providers;
    // "*" means whatever DSH currently has loaded; it cannot be narrowed with IDs.
    if (providers.includes('*') && providers.length !== 1) {
      throw new Error('Configure either "*" alone or explicit provider IDs, not both.');
    }
    this.everyProvider = providers.length === 1 && providers[0] === '*';
    this.routes = new Set(this.everyProvider ? [] : providers);
    this.protectedAgents = new WeakSet();
  }

  // Loaded and allowlisted routes are the same live set for every entry point,
  // so catalog, resolution, dispatch and follow-ups agree at every moment.
  loadedProviders() {
    return this.context.llm.listProviders().map(provider => provider.id);
  }

  async describe() {
    const llm = this.context.llm;
    const live = this.loadedProviders();
    const loaded = new Set(live);
    const providers = this.everyProvider ? live : [...this.routes];
    const models = [];
    const unavailable = [];
    for (const provider of providers) {
      if (!loaded.has(provider)) { unavailable.push(provider);continue; }
      try {
        // One broken catalog must not hide models of healthy providers.
        const entries = [];
        for (const model of await llm.listModels(provider)) {
          const info = await llm.resolveModelInfo(provider, model.id);
          entries.push({ provider, model: model.id, name: model.name,
            efforts: info.reasoning?.efforts.map(e => e.id) ?? [], default_effort: info.reasoning?.defaultEffort ?? null });
        }
        models.push(...entries);
      } catch { unavailable.push(provider); }
    }
    return { models, unavailable_providers: unavailable, permission_control: this.permissionCapability() };
  }

  // Publish what this running plugin can offer the board. An older consumer
  // that never loaded this adapter simply omits the field from its heartbeat;
  // the board must then treat non-default permission choices as unavailable
  // instead of suggesting a setting the running plugin will ignore.
  permissionCapability() {
    let service;
    try { service = typeof this.context?.get === 'function' ? this.context.get('permissionPresets') : undefined; }
    catch { service = undefined; }
    // A service object alone is not enough: the adapter needs all three native
    // operations, so a partial/older implementation must not be advertised.
    if (!service || typeof service.catalog !== 'function' || typeof service.set !== 'function' || typeof service.current !== 'function') {
      return { available: false, presets: [] };
    }
    try {
      const options = service.catalog()?.options;
      const presets = DSH_PERMISSION_PRESETS.filter(name => (options ?? []).some(option => option?.value === name));
      return { available: presets.length > 0, presets };
    } catch { return { available: false, presets: [] }; }
  }

  observe(conversationIds) {
    return [...new Set(conversationIds)].map(id => ({
      id, status: this.context.agents.get(id)?.status ?? 'unloaded',
    }));
  }

  allow(route) {
    const provider = route?.provider;
    if (!this.everyProvider && !this.routes.has(provider)) throw new Error('The selected model provider is outside the worker allowlist.');
    // A native provider unloaded after selection must not receive new work or follow-ups.
    if (!this.loadedProviders().includes(provider)) throw new Error('The selected model provider is not loaded in this desktop profile.');
  }

  protect(agent) {
    if (this.protectedAgents.has(agent)) return;
    this.protectedAgents.add(agent);
    const off = agent.ctx.on('agent/request', async (_message, next) => {
      const route = await next();this.allow(route);return route;
    }, { prepend: true });
    this.context.effect(() => off, 'codex-to-agents model boundary');
  }

  async choose(input) {
    const fallback = this.context.agentDefaultModel.currentSelection();
    const provider = input.provider ?? fallback.provider;
    const model = input.model ?? fallback.model;
    this.allow({ provider });
    const catalog = await this.describe();
    const entry = catalog.models.find(item => item.provider === provider && item.model === model);
    if (!entry) throw new Error('Model not available in this desktop profile.');
    const effort = input.effort === 'default' ? undefined : input.effort ?? entry.default_effort ?? undefined;
    if (effort !== undefined && !entry.efforts.includes(effort)) throw new Error('Unsupported model effort.');
    const resolved = await this.context.llm.resolveCallConfig({ provider, model, ...(effort ? { reasoningEffort: effort } : {}) });
    this.allow(resolved);
    return { provider: resolved.provider, model: resolved.model,
      ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}) };
  }

  // The permission choice belongs to the user and lives beside the other board
  // preferences. Read it fresh for each new session so a saved change applies
  // to later dispatch sessions without touching existing ones.
  async newSessionPermission() {
    if (!this.settings?.home) return null;
    let text;
    try { text = await readFile(join(this.settings.home, 'delegation.json'), 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error(`自动派工设置无法读取，无法确认新会话权限，已阻止派工：${error.message}`);
    }
    let setting;
    try { setting = JSON.parse(text); }
    catch { throw new Error('自动派工设置无法解析，无法确认新会话权限，已阻止派工。请在看板重新保存设置。'); }
    const value = setting?.dsh_permission;
    // Only an absent field means "follow the DSH default": the adapter must not
    // switch any knob in that case. A present-but-invalid value is explicit and
    // must fail instead of silently following the default.
    if (value === undefined) return null;
    if (typeof value !== 'string' || !DSH_PERMISSION_PRESETS.includes(value)) {
      throw new Error(`新会话权限设置值不受支持：${JSON.stringify(value)}。已阻止派工，请在看板重新选择。`);
    }
    return value;
  }

  permissionService() {
    // ctx.get() reads a service without declaring a hard inject dependency, so
    // an older DSH that lacks the permission package still loads this plugin;
    // only an explicit user choice then fails, with a readable reason.
    let service;
    try { service = typeof this.context?.get === 'function' ? this.context.get('permissionPresets') : undefined; }
    catch { service = undefined; }
    if (!service || typeof service.set !== 'function' || typeof service.current !== 'function') {
      throw new Error('DSH 当前未提供新会话权限控制，已阻止派工，避免以其他权限启动任务。');
    }
    return service;
  }

  // Resolve the native preset before the session exists: a missing capability
  // or preset must stop dispatch instead of starting with another permission.
  checkPermissionPreset(name) {
    const service = this.permissionService();
    let options;
    try { options = service.catalog?.()?.options; }
    catch (error) { throw new Error(`DSH 权限目录读取失败，已阻止派工：${error.message}`); }
    if (!Array.isArray(options) || !options.some(option => option?.value === name)) {
      throw new Error(`DSH 当前未提供权限预设“${dshPermissionName(name)}”，已阻止派工，避免以其他权限启动任务。`);
    }
    return service;
  }

  // Apply and verify on the fresh session before the first task message. The
  // native service records the preset and writes both knobs; verification reads
  // the effective value back, so a reported success is not a UI-only value.
  async applyPermission(agent, name, service) {
    const session = agent?.session;
    if (!session) throw new Error('DSH 会话尚未就绪，无法应用新会话权限，已阻止派工。');
    try { await service.set(session, name); }
    catch (error) { throw new Error(`DSH 未应用新会话权限“${dshPermissionName(name)}”，已阻止派工：${error.message}`); }
    let effective;
    try { effective = service.current(session); }
    catch (error) { throw new Error(`DSH 无法确认新会话权限，已阻止派工：${error.message}`); }
    if (effective !== name) {
      throw new Error(`DSH 新会话权限未生效（请求“${dshPermissionName(name)}”，实际 ${effective}），已阻止派工。`);
    }
    return { preset: name, effective };
  }

  async start(order) {
    const input = order.payload;
    // Read and validate the user preference before creating anything; a
    // configured-but-unavailable permission must never fall back silently.
    const permission = await this.newSessionPermission();
    const permissionService = permission ? this.checkPermissionPreset(permission) : undefined;
    const route = await this.choose(input);
    const location = input.workspace_id ? { workspaceId: this.workspace(input.workspace_id).id }
      : { cwd: await this.directory(input.directory ?? this.settings.defaultDirectory, false) };
    const sessionId = `cw-${order.id}`;
    const created = await this.context.sessionController.create({ sessionId, ...location });
    if (created.sessionId !== sessionId) throw new Error('Desktop returned an unexpected conversation identity.');
    const agent = this.context.agents.get(sessionId);
    this.protect(agent);
    const applied = permission ? await this.applyPermission(agent, permission, permissionService) : undefined;
    // This session-local selection avoids selectModel(), whose documented
    // behavior also saves the desktop's global default.
    this.context.sessionController.agents.selectForNextRequest(agent, route);
    await this.context.sessionController.rename({ sessionId, title: input.title ?? input.goal.slice(0, 70) });
    const checkpoint = await this.checkpoint(sessionId, route);
    return applied ? { ...checkpoint, permission: applied } : checkpoint;
  }

  async checkpoint(sessionId, route) {
    const snapshot = await this.context.sessionQuery.readSession(sessionId);
    if (!route) {
      const last = snapshot.events.findLast(event => ['model/selection', 'request/header'].includes(event.type));
      route = last?.type === 'model/selection' ? last.data : last?.data.header?.config;
    }
    this.allow(route);
    return { conversation_id: sessionId, checkpoint: snapshot.events.at(-1)?.seq ?? -1,
      directory: snapshot.session.cwd, route };
  }

  async send(order, location, message, delivery) {
    if (this.context.workspaceRegistry.archivedSessionIds.includes(location.conversation_id)) throw new Error('Restore the archived conversation before sending work.');
    const found = await this.context.sessionController.agents.resolveAgent(location.conversation_id);
    if (found.error) throw found.error;
    this.protect(found.agent);
    await this.context.sessionController.prompt({
      sessionId: location.conversation_id, requestId: order.id, mode: delivery,
      content: [{ type: 'text', text: message }],
    }, AbortSignal.timeout(25000));
  }

  async progress(order, state) {
    const { events } = await this.context.sessionQuery.readSession(state.conversation_id);
    const committed = events.find(event => event.type === 'user/message' && event.data.source?.rpcId === order.id);
    const input = committed ?? claimedMessage(events, order.id);
    if (!input) return { status: state.status === 'uncertain' ? 'uncertain' : 'executing', progress: 'Waiting for DSH to admit this message.' };
    const subsequent = events.filter(event => event.seq > input.seq);
    const end = subsequent.find(event => event.type === 'turn/end');
    const relevant = end ? subsequent.filter(event => event.seq <= end.seq) : subsequent;
    const text = (committed ? relevant : []).filter(event => event.type === 'assistant/message')
      .flatMap(event => event.data.message?.content ?? []).filter(block => block.type === 'text')
      .map(block => block.text).join('\n').slice(-20000);
    const native = end?.data.reason;
    if (!native) return { status: 'executing', progress: text || 'DSH is executing.' };
    const status = native.kind === 'completed' ? committed ? 'completed' : 'uncertain'
      : native.kind === 'error' ? 'failed' : native.kind === 'blocked' ? 'blocked' : 'cancelled';
    const progress = text || native.error?.message || (status === 'uncertain' ? 'DSH ended before committing this prompt; inspect native history.' : '');
    return { status, progress, output: { text, native_reason: native, conversation_id: state.conversation_id } };
  }

  workspace(id) {
    const workspace = this.context.workspaceRegistry.get(id);
    if (!workspace) throw new Error('Workspace does not exist.');
    return workspace;
  }

  async directory(path, create) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('An absolute directory is required.');
    if (create) await mkdir(path, { recursive: true });
    return realpath(path);
  }

  async workspaceAction(input) {
    const api = this.context.workspaceController;
    if (input.action === 'list') return { workspaces: this.context.workspaceRegistry.list().map(item => ({ id: item.id, title: item.title, directory: item.path, conversations: item.sessionIds.length })) };
    if (input.action === 'register') {
      const result = await api.create({ path: await this.directory(input.directory, true) });
      let workspace = result.workspace;
      if (input.title && result.created) workspace = (await api.rename({ workspaceId: workspace.workspaceId, title: input.title })).workspace;
      return { id: workspace.workspaceId, title: workspace.title, directory: workspace.path, created: result.created };
    }
    this.workspace(input.workspace_id);
    if (input.action === 'rename') return api.rename({ workspaceId: input.workspace_id, title: input.title });
    await api.delete({ workspaceId: input.workspace_id });
    return { removed: true, disk_files_retained: true, conversations_retained: true };
  }

  async conversationAction(input) {
    const api = this.context.workspaceController;
    if (input.action === 'rename') return this.context.sessionController.rename({ sessionId: input.conversation_id, title: input.title });
    if (input.action === 'archive') {
      await api.archiveSession({ sessionId: input.conversation_id, stopActivity: input.stop_running });
      return { archived: true, history_retained: true };
    }
    if (input.action === 'restore') {
      await api.unarchiveSession({ sessionId: input.conversation_id });return { restored: true };
    }
    const archived = new Set(this.context.workspaceRegistry.archivedSessionIds);
    const members = input.workspace_id ? new Set(this.workspace(input.workspace_id).sessionIds) : null;
    const records = (await this.context.sessionQuery.listSessions()).filter(({ header }) => header.origin !== 'subagent'
      && (input.include_archived || !archived.has(header.id)) && (!members || members.has(header.id)));
    const page = records.slice(input.offset, input.offset + input.limit);
    return { total: records.length, conversations: await Promise.all(page.map(async ({ header }) => ({
      id: header.id, title: await this.context.sessionQuery.readTitle(header.id) ?? '', directory: header.cwd,
      archived: archived.has(header.id), status: this.context.agents.get(header.id)?.status ?? 'idle',
    }))) };
  }

  cancel(sessionId) { return this.context.sessionController.cancel({ sessionId }); }
}

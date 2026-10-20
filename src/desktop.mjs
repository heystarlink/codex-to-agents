import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

// Only this adapter knows DSH service names. Queue and MCP code know work orders.
export class Desktop {
  constructor(context, settings) {
    this.context = context;
    this.settings = settings;
    this.routes = new Set(settings.providers);
    this.protectedAgents = new WeakSet();
  }

  async describe() {
    const llm = this.context.llm;
    const loaded = new Set(llm.listProviders().map(provider => provider.id));
    const models = [];
    const unavailable = [];
    for (const provider of this.routes) {
      if (!loaded.has(provider)) { unavailable.push(provider);continue; }
      const listed = await llm.listModels(provider);
      for (const model of listed) {
        const info = await llm.resolveModelInfo(provider, model.id);
        models.push({ provider, model: model.id, name: model.name,
          efforts: info.reasoning?.efforts.map(e => e.id) ?? [], default_effort: info.reasoning?.defaultEffort ?? null });
      }
    }
    return { models, unavailable_providers: unavailable };
  }

  observe(conversationIds) {
    return [...new Set(conversationIds)].map(id => ({
      id, status: this.context.agents.get(id)?.status ?? 'unloaded',
    }));
  }

  allow(route) {
    if (!this.routes.has(route?.provider)) throw new Error('The selected model provider is outside the worker allowlist.');
  }

  protect(agent) {
    if (this.protectedAgents.has(agent)) return;
    this.protectedAgents.add(agent);
    const off = agent.ctx.on('agent/request', async (_message, next) => {
      const route = await next();this.allow(route);return route;
    });
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

  async start(order) {
    const input = order.payload;
    const route = await this.choose(input);
    const location = input.workspace_id ? { workspaceId: this.workspace(input.workspace_id).id }
      : { cwd: await this.directory(input.directory ?? this.settings.defaultDirectory, false) };
    const sessionId = `cw-${order.id}`;
    const created = await this.context.sessionController.create({ sessionId, ...location });
    if (created.sessionId !== sessionId) throw new Error('Desktop returned an unexpected conversation identity.');
    const agent = this.context.agents.get(sessionId);
    this.protect(agent);
    // This session-local selection avoids selectModel(), whose documented
    // behavior also saves the desktop's global default.
    this.context.sessionController.agents.selectForNextRequest(agent, route);
    await this.context.sessionController.rename({ sessionId, title: input.title ?? input.goal.slice(0, 70) });
    return this.checkpoint(sessionId, route);
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
    const input = events.find(event => event.type === 'user/message' && event.data.source?.rpcId === order.id);
    if (!input) return { status: state.status === 'uncertain' ? 'uncertain' : 'executing', progress: 'Waiting for DSH to admit this message.' };
    const subsequent = events.filter(event => event.seq > input.seq);
    const end = subsequent.find(event => event.type === 'turn/end');
    const relevant = end ? subsequent.filter(event => event.seq <= end.seq) : subsequent;
    const text = relevant.filter(event => event.type === 'assistant/message')
      .flatMap(event => event.data.message?.content ?? []).filter(block => block.type === 'text')
      .map(block => block.text).join('\n').slice(-20000);
    const native = end?.data.reason;
    if (!native) return { status: 'executing', progress: text || 'DSH is executing.' };
    const status = native.kind === 'completed' ? 'completed'
      : native.kind === 'error' ? 'failed' : native.kind === 'blocked' ? 'blocked' : 'cancelled';
    return { status, progress: text, output: { text, native_reason: native, conversation_id: state.conversation_id } };
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

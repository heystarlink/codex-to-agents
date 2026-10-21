import { mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { HermesClient } from './hermes-client.mjs';
import { OrderBook } from './orders.mjs';

const marker = id => `[codex-to-agents:${id}]`;
const running = status => ['working', 'waiting', 'starting', 'streaming'].includes(status);
const textOf = message => typeof message.content === 'string' ? message.content
  : Array.isArray(message.content) ? message.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : message.text ?? '';

export class Hermes {
  constructor(settings, client = new HermesClient(settings)) {
    this.settings = settings;
    this.client = client;
    this.book = new OrderBook(settings.home);
    this.receipts = join(settings.home, 'hermes-receipts');
    this.turns = new Map();
    this.byLive = new Map();
    this.live = new Map();
    this.writes = Promise.resolve();
    this.client.onEvent = event => this.event(event);
  }

  async open() {
    await mkdir(this.receipts, { recursive: true, mode: 0o700 });
    for (const file of await readdir(this.receipts)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue;
      const receipt = JSON.parse(await readFile(join(this.receipts, file), 'utf8'));
      this.turns.set(receipt.order_id, receipt);
      if (!['completed', 'failed', 'cancelled'].includes(receipt.status)) this.byLive.set(receipt.native_session_id, receipt.order_id);
    }
  }

  async describe() {
    const data = await this.client.request('/api/model/options');
    this.options = data;
    const allowed = this.settings.providers;
    const providers = data.providers.filter(provider => provider.authenticated !== false && (!allowed?.length || allowed.includes(provider.slug)));
    return {
      executor: 'hermes', default_provider: data.provider, default_model: data.model,
      capabilities: { directories: true, workspaces: false, follow_up: true, steer: true, cancel: true, conversations: true },
      models: providers.flatMap(provider => provider.models.map(model => ({
        provider: provider.slug, model, name: model, reasoning: Boolean(provider.capabilities?.[model]?.reasoning),
      }))),
    };
  }

  async observe(ids) {
    const { sessions } = await this.client.call('session.active_list');
    this.live = new Map(sessions.map(session => [session.session_key, session]));
    for (const receipt of this.turns.values()) {
      const session = this.live.get(receipt.conversation_id);
      if (receipt.status !== 'executing' || !session || !running(session.status) || receipt.attached_generation === this.client.generation) continue;
      const attached = await this.client.call('session.activate', { session_id: session.id });
      if (attached.inflight?.user && !String(attached.inflight.user).startsWith(marker(receipt.order_id) + '\n')) {
        this.byLive.delete(receipt.native_session_id);
        continue;
      }
      receipt.native_session_id = session.id;
      receipt.attached_generation = this.client.generation;
      this.byLive.set(session.id, receipt.order_id);
    }
    return [...new Set(ids)].map(id => {
      const session = this.live.get(id);
      return { id, status: !session ? 'unloaded' : running(session.status) ? 'running' : 'idle', native_status: session?.status ?? null };
    });
  }

  async ready(id) {
    await this.observe([id]);
    return !running(this.live.get(id)?.status);
  }

  async start(order) {
    const input = order.payload;
    if (input.effort && !['default', 'none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(input.effort)) {
      throw new Error('Unsupported Hermes reasoning effort.');
    }
    const catalog = await this.describe();
    const provider = input.provider ?? this.options.provider;
    const model = input.model ?? (provider === this.options.provider ? this.options.model : null);
    const selected = catalog.models.find(entry => entry.provider === provider && entry.model === model);
    if (!selected) {
      throw new Error('Choose an available Hermes provider and model from runtime_info.');
    }
    if (input.effort && !['default', 'none', 'off'].includes(input.effort) && !selected.reasoning) {
      throw new Error('This Hermes model does not advertise reasoning effort support.');
    }
    const path = input.directory ?? this.settings.defaultDirectory;
    if (!path || !isAbsolute(path)) throw new Error('Hermes needs an absolute task directory.');
    const directory = await realpath(path);
    if (!(await stat(directory)).isDirectory()) throw new Error('Hermes task directory must be a directory.');
    const result = await this.client.call('session.create', {
      cwd: directory, title: input.title ?? input.goal.slice(0, 70), provider, model,
      ...(input.effort && input.effort !== 'default' ? { reasoning_effort: input.effort } : {}),
    });
    const location = { conversation_id: result.stored_session_id, native_session_id: result.session_id, directory, route: { provider, model } };
    if (!location.conversation_id || !location.native_session_id) throw Object.assign(new Error('Hermes returned no persistent session identity.'), { deliveryUnknown: true });
    this.live.set(location.conversation_id, { id: location.native_session_id, session_key: location.conversation_id, status: 'starting' });
    return location;
  }

  async checkpoint(id) {
    const detail = await this.client.request('/api/sessions/' + encodeURIComponent(id));
    if (detail.archived) throw new Error('Restore the archived Hermes conversation before sending work.');
    const result = await this.client.call('session.resume', { session_id: id });
    // Named custom providers report the runtime alias "custom" in session.info.
    // Their routable identity is preserved in the native session's model_config.
    const config = typeof detail.model_config === 'string' ? JSON.parse(detail.model_config) : detail.model_config;
    const provider = result.info?.provider === 'custom' ? config?.provider : result.info?.provider ?? config?.provider;
    if (this.settings.providers?.length && !this.settings.providers.includes(provider)) {
      throw new Error('The Hermes conversation provider is outside the worker allowlist or cannot be confirmed.');
    }
    return { conversation_id: result.session_key ?? result.resumed ?? id, native_session_id: result.session_id,
      route: { provider, model: result.info?.model } };
  }

  async send(order, location, message, mode) {
    if (mode === 'steer') {
      const result = await this.client.call('session.steer', { session_id: location.native_session_id, text: message }, order.id);
      if (result.status !== 'queued') throw Object.assign(new Error('Hermes did not accept the steer instruction. Use append when the conversation is idle.'), { definite: true });
      return { status: 'completed', progress: 'Steer instruction accepted by Hermes.', output: { steer_accepted: true, conversation_id: location.conversation_id } };
    }
    const receipt = { order_id: order.id, ...location, attached_generation: this.client.generation, status: 'executing', progress: 'Message submitted to Hermes.', text: '' };
    this.turns.set(order.id, receipt);this.byLive.set(location.native_session_id, order.id);
    await this.save(receipt);
    let result;
    try { result = await this.client.call('prompt.submit', { session_id: location.native_session_id, text: marker(order.id) + '\n' + message }, order.id); }
    catch (error) {
      if (error.definite) {
        receipt.status = 'failed';receipt.progress = error.message;
        receipt.output = { text: error.message, native_status: 'rejected', conversation_id: location.conversation_id };
        this.byLive.delete(location.native_session_id);await this.save(receipt);
      }
      throw error;
    }
    if (result.status !== 'streaming') {
      throw Object.assign(new Error('Hermes applied its busy-input policy; inspect the native conversation before retrying.'), { deliveryUnknown: true });
    }
    return { progress: 'Message submitted to Hermes.' };
  }

  event(event) {
    const receipt = this.turns.get(this.byLive.get(event?.session_id));
    if (!receipt) return;
    const payload = event.payload ?? {};
    if (event.type === 'message.delta') {
      receipt.text = (receipt.text + (payload.text ?? '')).slice(-20000);
      receipt.progress = receipt.text;
      return;
    }
    else if (event.type === 'tool.start') receipt.progress = `Hermes is running ${payload.name ?? payload.tool ?? 'a tool'}.`;
    else if (['approval.request', 'clarify.request', 'sudo.request', 'secret.request'].includes(event.type)) {
      receipt.progress = `Hermes needs user input (${event.type}); open the native conversation.`;
    } else if (event.type === 'error' || event.type === 'message.complete') {
      const status = event.type === 'error' ? 'failed' : payload.status === 'complete' ? 'completed'
        : payload.status === 'interrupted' ? 'cancelled' : 'failed';
      receipt.status = status;
      receipt.text = String(payload.text ?? payload.message ?? receipt.text).slice(-20000);
      receipt.output = { text: receipt.text, native_status: payload.status ?? 'error', conversation_id: receipt.conversation_id };
      receipt.progress = receipt.text;
      this.byLive.delete(event.session_id);
    } else return;
    this.save(receipt).catch(() => {});
  }

  save(receipt) {
    const snapshot = structuredClone(receipt);
    this.writes = this.writes.then(() => this.book.atomic(join(this.receipts, `${receipt.order_id}.json`), snapshot))
      .catch(error => { this.writeError = error; });
    return this.writes.then(() => { if (this.writeError) throw this.writeError; });
  }

  async progress(order, state) {
    await this.writes;
    if (this.writeError) throw this.writeError;
    const receipt = this.turns.get(order.id);
    if (receipt && ['completed', 'failed', 'cancelled'].includes(receipt.status)) {
      return { status: receipt.status, progress: receipt.progress, output: receipt.output, error: receipt.status === 'failed' ? receipt.output.text : null };
    }
    const session = this.live.get(state.conversation_id);
    if (receipt && this.client.socket?.readyState === 1 && session?.id === receipt.native_session_id && this.byLive.get(session.id) === order.id) {
      if (running(session.status)) return { status: 'executing', progress: receipt.progress };
    }
    // A lost socket may have missed the final event. Show only this order's
    // native transcript; absence of a terminal receipt is never proof of success.
    const result = await this.client.request('/api/sessions/' + encodeURIComponent(state.conversation_id) + '/messages');
    const messages = result.messages;
    const index = messages.findIndex(message => message.role === 'user' && textOf(message).startsWith(marker(order.id) + '\n'));
    let text = '';
    if (index !== -1) {
      const following = messages.slice(index + 1);
      const boundary = following.findIndex(message => message.role === 'user');
      text = (boundary === -1 ? following : following.slice(0, boundary)).filter(message => message.role === 'assistant')
        .map(textOf).filter(Boolean).join('\n').slice(-20000);
    }
    return { status: 'uncertain', progress: text || 'No confirmed Hermes terminal receipt. Inspect the native conversation; this order will not be replayed.',
      ...(text ? { output: { text, terminal_confirmed: false, conversation_id: state.conversation_id } } : {}) };
  }

  async cancel(id) {
    await this.observe([id]);
    const session = this.live.get(id);
    if (session) await this.client.call('session.interrupt', { session_id: session.id });
    else await this.client.request('/api/sessions/' + encodeURIComponent(id));
    return { native_queue_cleared: true, queued_messages_retained: false, local_queued_orders_retained: true, native_session_active: Boolean(session) };
  }

  async workspaceAction() { throw new Error('Hermes has no desktop workspace registry. Use a task directory.'); }

  async conversationAction(input) {
    if (input.action === 'list') {
      const query = new URLSearchParams({ limit: String(input.limit), offset: String(input.offset), archived: input.include_archived ? 'include' : 'exclude' });
      const result = await this.client.request('/api/sessions?' + query);
      return { total: result.total, conversations: result.sessions.map(session => ({ id: session.id, title: session.title, directory: session.cwd, archived: Boolean(session.archived) })) };
    }
    if (input.action === 'archive' && !await this.ready(input.conversation_id)) {
      if (!input.stop_running) throw new Error('Archiving a running Hermes conversation needs stop_running=true.');
      await this.cancel(input.conversation_id);
    }
    const body = input.action === 'rename' ? { title: input.title } : { archived: input.action === 'archive' };
    return this.client.request('/api/sessions/' + encodeURIComponent(input.conversation_id), { method: 'PATCH', body });
  }

  async close() { await this.writes;this.client.close(); }
}

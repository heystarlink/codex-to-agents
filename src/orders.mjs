import { z } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, rename, link, unlink, chmod } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { EXECUTORS, isExecutor, runtimeFile, executorLabel } from './executors.mjs';
import { TERMINAL, notifyOrderChanged } from './order-cache.mjs';

const nonempty = z.string().trim().min(1);
const executor = z.enum(EXECUTORS).optional();

// Shared by every MCP registration that accepts a work-order UUID. MCP clients
// validate arguments before our handlers run, so the parameter description and
// the zod message are the only guidance a caller receives for a malformed ID.
export const ORDER_ID_DESCRIPTION = 'Optional UUID for this work order. Omit it and the server generates one. If you supply it, generate a real UUID with a UUID generator (for example crypto.randomUUID()) before the first call; on an uncertain retry, reuse that same UUID with identical arguments. Never use a task title, cw- conversation ID, or example placeholder.';
const ORDER_ID_ERROR = 'order_id must be a real UUID, not a task title, cw- conversation ID, or example placeholder. Omit order_id on the first call and the server generates one; or generate a real UUID (for example with crypto.randomUUID()) before the first call and reuse that same UUID with identical arguments when retrying.';
const TARGET_ORDER_DESCRIPTION = 'UUID of the work order to follow up. Must be an order_id returned by work_submit or work_update; task titles and cw- conversation IDs are not valid.';
const TARGET_ORDER_ERROR = 'target_order must be a real UUID returned by work_submit or work_update, not a task title, cw- conversation ID, or example placeholder.';
export const INSPECT_ORDER_ID_DESCRIPTION = 'UUID of a saved work order. Omit it to list recent work orders. Must be an order_id returned by work_submit or work_update; task titles and cw- conversation IDs are not valid.';
const INSPECT_ORDER_ID_ERROR = 'order_id must be a real UUID returned by work_submit or work_update, not a task title, cw- conversation ID, or example placeholder. Omit order_id to list recent work orders.';
const optionalUuid = (description, error) => z.uuid({ error }).optional().describe(description);
const orderId = optionalUuid(ORDER_ID_DESCRIPTION, ORDER_ID_ERROR);
const targetOrder = optionalUuid(TARGET_ORDER_DESCRIPTION, TARGET_ORDER_ERROR);
export const inspectOrderId = optionalUuid(INSPECT_ORDER_ID_DESCRIPTION, INSPECT_ORDER_ID_ERROR);

export const definitions = {
  work_submit: {
    text: 'Save a work order for an execution agent. executor selects dsh (default), hermes or qoder. Returns an order ID immediately, even offline. Omit order_id and the server generates a UUID; if you supply it, generate a real UUID (for example with crypto.randomUUID()) before the first call and reuse that same order_id with identical arguments for an uncertain retry. Never use a task title, cw- conversation ID, or example placeholder.',
    schema: z.object({ order_id: orderId, executor, goal: nonempty.max(50000), directory: nonempty.optional(), workspace_id: nonempty.optional(), title: nonempty.max(100).optional(), provider: nonempty.optional(), model: nonempty.optional(), effort: nonempty.optional() }).strict()
      .refine(v => !(v.directory && v.workspace_id), 'Choose directory or workspace_id.'),
  },
  work_update: {
    text: 'Save a follow-up or cancellation. target_order inherits its executor; when addressing conversation_id select executor explicitly. Hermes interrupt delivers a steer acknowledgement; cancel requests interruption. Qoder supports append/cancel but not interrupt.',
    schema: z.object({ order_id: orderId, executor, target_order: targetOrder, conversation_id: nonempty.optional(), action: z.enum(['append', 'interrupt', 'cancel']), message: nonempty.max(50000).optional() }).strict()
      .refine(v => Boolean(v.target_order) !== Boolean(v.conversation_id), 'Choose exactly one target.')
      .refine(v => v.action === 'cancel' || v.message, 'A message is required for append/interrupt.'),
    destructive: true,
  },
  workspace_control: {
    text: 'Queue a DSH desktop workspace operation. remove only unregisters the workspace, retaining disk files and chat history.',
    schema: z.object({ order_id: orderId, executor, action: z.enum(['list', 'register', 'rename', 'remove']), workspace_id: nonempty.optional(), directory: nonempty.optional(), title: nonempty.max(100).optional() }).strict()
      .refine(v => v.action !== 'register' || v.directory, 'register needs directory.')
      .refine(v => !['rename', 'remove'].includes(v.action) || v.workspace_id, 'workspace_id is required.')
      .refine(v => v.action !== 'rename' || v.title, 'rename needs title.'),
    destructive: true,
  },
  conversation_control: {
    text: 'Queue list, rename, archive or restore of agent conversations. executor selects dsh (default), hermes or qoder. Qoder has no verified session-management commands, so these actions are rejected explicitly instead of deleting sessions. Archive of running work needs stop_running=true.',
    schema: z.object({ order_id: orderId, executor, action: z.enum(['list', 'rename', 'archive', 'restore']), conversation_id: nonempty.optional(), workspace_id: nonempty.optional(), title: nonempty.max(100).optional(), include_archived: z.boolean().default(false), stop_running: z.boolean().default(false), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(30) }).strict()
      .refine(v => v.action === 'list' || v.conversation_id, 'conversation_id is required.')
      .refine(v => v.action !== 'rename' || v.title, 'rename needs title.'),
    destructive: true,
  },
};

const identifier = id => {
  if (!z.uuid().safeParse(id).success) throw new Error('Invalid order_id: pass the UUID returned by work_submit or work_update.');
  return id;
};
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export { TERMINAL };

async function readJson(path, missing = null) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return missing;throw error; }
}

export class OrderBook {
  constructor(home) {
    if (!isAbsolute(home)) throw new Error('Order directory must be absolute.');
    this.home = home;
    this.requests = join(home, 'requests');
    this.states = join(home, 'states');
  }

  async open() {
    for (const path of [this.home, this.requests, this.states]) {
      await mkdir(path, { recursive: true, mode: 0o700 });await chmod(path, 0o700);
    }
  }

  async atomic(path, value, exclusive = false) {
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      if (exclusive) await link(temp, path);
      else await rename(temp, path);
    } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }

  async submit(kind, input) {
    const definition = definitions[kind];
    if (!definition) throw new Error('Unknown work order kind.');
    const parsed = definition.schema.parse(input);
    const { order_id, ...payload } = parsed;
    if (kind === 'work_update' && payload.target_order) {
      const target = await this.request(payload.target_order);
      if (!target) throw new Error('Target work order not found.');
      const inherited = target.payload.executor ?? 'dsh';
      if (payload.executor && payload.executor !== inherited) throw new Error('executor must match the target work order.');
      // Persist the inherited executor for every consumer that is not the DSH
      // default, so the owning consumer can filter its own updates.
      if (inherited !== 'dsh') payload.executor = inherited;
    }
    if (payload.executor && payload.executor !== 'dsh' && (kind === 'workspace_control' || payload.workspace_id)) {
      const label = executorLabel(payload.executor);
      throw new Error(`${label} uses a session directory; desktop workspace operations are not supported. Use directory instead.`);
    }
    if (payload.executor && payload.executor !== 'dsh') {
      const { snapshot } = await this.runtime();
      if (snapshot?.active && snapshot.protocol !== 2) {
        let alive = true;
        if (Number.isInteger(snapshot.pid) && snapshot.pid > 0) {
          try { process.kill(snapshot.pid, 0); }
          catch (error) { if (error.code === 'ESRCH') alive = false;else throw error; }
        }
        if (alive) throw new Error(`Reload the DSH consumer before submitting ${executorLabel(payload.executor)} work: the running legacy consumer does not filter executors. Run the DSH enable command again.`);
      }
    }
    const id = order_id ?? randomUUID();
    const request = { id, kind, payload, fingerprint: digest({ kind, payload }), created_at: new Date().toISOString() };
    await this.open();
    let reused = false;
    try { await this.atomic(join(this.requests, `${id}.json`), request, true); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await this.request(id);
      if (existing.fingerprint !== request.fingerprint) throw new Error('order_id is already bound to different work. Reuse the original arguments with this order_id, or generate a new UUID for different work.');
      reused = true;
    }
    // Same-process consumers update their index immediately; other processes
    // see the atomically renamed request file through their own watcher.
    if (!reused) notifyOrderChanged(this.home, { id, request, state: { status: 'queued' } });
    return { order_id: id, reused, ...await this.inspect(id) };
  }

  request(id) { return readJson(join(this.requests, `${identifier(id)}.json`)); }

  state(id) { return readJson(join(this.states, `${identifier(id)}.json`)); }

  async inspect(id) {
    const request = await this.request(id);
    if (!request) throw new Error('Work order not found.');
    const state = await readJson(join(this.states, `${id}.json`));
    return { order_id: id, kind: request.kind, executor: request.payload.executor ?? 'dsh', created_at: request.created_at, ...(state ?? { status: 'queued', events: [] }) };
  }

  async transition(id, status, detail = {}) {
    const before = await this.inspect(id);
    const time = new Date().toISOString();
    const value = {
      ...before, ...detail, status, updated_at: time,
      events: [...before.events, { at: time, status }].slice(-40),
    };
    delete value.kind;delete value.created_at;
    await this.atomic(join(this.states, `${identifier(id)}.json`), value);
    notifyOrderChanged(this.home, { id, state: value });
    return value;
  }

  async list() {
    const files = await readdir(this.requests);
    const orders = await Promise.all(files.filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).map(name => this.inspect(name.slice(0, -5))));
    return orders.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.order_id.localeCompare(b.order_id));
  }

  async runtime(value, executor = 'dsh') {
    if (!isExecutor(executor)) throw new Error('Unknown executor.');
    const path = join(this.home, runtimeFile(executor));
    if (value) await this.atomic(path, value);
    const stored = value ?? await readJson(path);
    return {
      online: Boolean(stored?.active && Date.now() - Date.parse(stored.at) < 6000),
      snapshot: stored,
    };
  }

  async runtimes() {
    const entries = await Promise.all(EXECUTORS.map(async name => [name, await this.runtime(null, name)]));
    const executors = Object.fromEntries(entries);
    const online = entries.find(([, runtime]) => runtime.online);
    // Prefer a live executor; otherwise keep the historical DSH-first snapshot
    // so existing callers that expect a DSH heartbeat keep working.
    return { online: Boolean(online), snapshot: (online ?? executors.dsh).snapshot, executors };
  }
}

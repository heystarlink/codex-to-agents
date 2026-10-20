import { z } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, rename, link, unlink, chmod } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';

const nonempty = z.string().trim().min(1);
const optionalId = z.uuid().optional();
export const definitions = {
  work_submit: {
    text: 'Save a work order for DSH to execute. Returns an order ID immediately, even when the worker is offline. Include an order_id before first submission for safe retries.',
    schema: z.object({ order_id: optionalId, goal: nonempty.max(50000), directory: nonempty.optional(), workspace_id: nonempty.optional(), title: nonempty.max(100).optional(), provider: nonempty.optional(), model: nonempty.optional(), effort: nonempty.optional() }).strict()
      .refine(v => !(v.directory && v.workspace_id), 'Choose directory or workspace_id.'),
  },
  work_update: {
    text: 'Save a follow-up or cancellation order. Address an existing DSH conversation explicitly, or reference a work order whose conversation has been created.',
    schema: z.object({ order_id: optionalId, target_order: z.uuid().optional(), conversation_id: nonempty.optional(), action: z.enum(['append', 'interrupt', 'cancel']), message: nonempty.max(50000).optional() }).strict()
      .refine(v => Boolean(v.target_order) !== Boolean(v.conversation_id), 'Choose exactly one target.')
      .refine(v => v.action === 'cancel' || v.message, 'A message is required for append/interrupt.'),
    destructive: true,
  },
  workspace_control: {
    text: 'Queue a DSH desktop workspace operation. remove only unregisters the workspace, retaining disk files and chat history.',
    schema: z.object({ order_id: optionalId, action: z.enum(['list', 'register', 'rename', 'remove']), workspace_id: nonempty.optional(), directory: nonempty.optional(), title: nonempty.max(100).optional() }).strict()
      .refine(v => v.action !== 'register' || v.directory, 'register needs directory.')
      .refine(v => !['rename', 'remove'].includes(v.action) || v.workspace_id, 'workspace_id is required.')
      .refine(v => v.action !== 'rename' || v.title, 'rename needs title.'),
    destructive: true,
  },
  conversation_control: {
    text: 'Queue list, rename, archive or restore of DSH desktop conversations, including existing conversations. Archive of running work needs stop_running=true.',
    schema: z.object({ order_id: optionalId, action: z.enum(['list', 'rename', 'archive', 'restore']), conversation_id: nonempty.optional(), workspace_id: nonempty.optional(), title: nonempty.max(100).optional(), include_archived: z.boolean().default(false), stop_running: z.boolean().default(false), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(30) }).strict()
      .refine(v => v.action === 'list' || v.conversation_id, 'conversation_id is required.')
      .refine(v => v.action !== 'rename' || v.title, 'rename needs title.'),
    destructive: true,
  },
};

const identifier = id => {
  if (!z.uuid().safeParse(id).success) throw new Error('Invalid work order ID.');
  return id;
};
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'blocked']);

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
    const id = order_id ?? randomUUID();
    const request = { id, kind, payload, fingerprint: digest({ kind, payload }), created_at: new Date().toISOString() };
    await this.open();
    let reused = false;
    try { await this.atomic(join(this.requests, `${id}.json`), request, true); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await this.request(id);
      if (existing.fingerprint !== request.fingerprint) throw new Error('order_id is already bound to different work.');
      reused = true;
    }
    return { order_id: id, reused, ...await this.inspect(id) };
  }

  request(id) { return readJson(join(this.requests, `${identifier(id)}.json`)); }

  async inspect(id) {
    const request = await this.request(id);
    if (!request) throw new Error('Work order not found.');
    const state = await readJson(join(this.states, `${id}.json`));
    return { order_id: id, kind: request.kind, created_at: request.created_at, ...(state ?? { status: 'queued', events: [] }) };
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
    return value;
  }

  async list() {
    const files = await readdir(this.requests);
    const orders = await Promise.all(files.filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).map(name => this.inspect(name.slice(0, -5))));
    return orders.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.order_id.localeCompare(b.order_id));
  }

  async runtime(value) {
    if (value) await this.atomic(join(this.home, 'runtime.json'), value);
    const stored = value ?? await readJson(join(this.home, 'runtime.json'));
    return {
      online: Boolean(stored?.active && Date.now() - Date.parse(stored.at) < 6000),
      snapshot: stored,
    };
  }
}

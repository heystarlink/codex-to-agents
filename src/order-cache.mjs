import { readFile, readdir, stat } from 'node:fs/promises';
import { watch } from 'node:fs';
import { join, resolve } from 'node:path';

// Keep this module dependency-free: the installed DSH runtime snapshot copies
// it, so it may only import Node builtins and must not import orders.mjs.
export const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'blocked']);
export const isTerminal = status => TERMINAL.has(status);

const UUID_FILE = /^[0-9a-f-]{36}\.json$/;
const SYNC_DEBOUNCE_MS = 25;
const DEFAULT_FALLBACK_MS = 2500;
const READ_CONCURRENCY = 16;
const ACTION_NAMES = { work_submit: '执行任务', work_update: '更新任务', workspace_control: '项目操作', conversation_control: '会话操作' };

const clean = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

export function orderTitle(request) {
  const input = request?.payload ?? {};
  return input.title ?? (clean(input.goal).trim().slice(0, 100) || `${ACTION_NAMES[request?.kind] ?? request?.kind} · ${input.action ?? ''}`);
}

async function readJson(path, missing = null) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return missing; throw error; }
}

async function listIds(directory) {
  try { return (await readdir(directory)).filter(name => UUID_FILE.test(name)).map(name => name.slice(0, -5)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function mapLimit(items, limit, run) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await run(items[next++]);
  });
  await Promise.all(workers);
}

// Only metadata is projected into the index. Goals, progress text and native
// outputs stay on disk so a large history cannot pin large strings in memory.
function project(request, state) {
  const input = request.payload ?? {};
  return {
    order_id: request.id,
    kind: request.kind,
    executor: input.executor ?? 'dsh',
    status: state?.status ?? 'queued',
    conversation_id: state?.conversation_id ?? null,
    created_at: request.created_at ?? null,
    updated_at: state?.updated_at ?? null,
    title: orderTitle(request),
    action: input.action ?? null,
    model: state?.route?.model ?? input.model ?? null,
    provider: state?.route?.provider ?? input.provider ?? null,
    directory: state?.directory ?? input.directory ?? null,
  };
}

const sameEntry = (a, b) => a.executor === b.executor && a.kind === b.kind && a.status === b.status
  && a.conversation_id === b.conversation_id && a.created_at === b.created_at && a.updated_at === b.updated_at
  && a.title === b.title && a.action === b.action && a.model === b.model && a.provider === b.provider
  && a.directory === b.directory;

// Same-process producers wake resident consumers without waiting for a file
// watcher. The map only lives while at least one subscriber exists, so no
// process-wide home cache is retained after close.
const listenersByHome = new Map();

export function subscribeOrderChanges(home, listener) {
  const key = resolve(home);
  let listeners = listenersByHome.get(key);
  if (!listeners) listenersByHome.set(key, listeners = new Set());
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) listenersByHome.delete(key);
  };
}

export function notifyOrderChanged(home, event) {
  const listeners = listenersByHome.get(resolve(home));
  if (!listeners) return;
  for (const listener of [...listeners]) {
    try { listener(event); } catch { /* a dead listener must not block publication */ }
  }
}

export class OrderIndex {
  constructor(home, { fallbackInterval = DEFAULT_FALLBACK_MS } = {}) {
    this.home = resolve(home);
    this.requests = join(this.home, 'requests');
    this.states = join(this.home, 'states');
    this.fallbackInterval = fallbackInterval;
    this.entries = new Map();
    this.invalid = new Map();
    this.versions = new Map();
    this.localEpoch = 0;
    this.syncError = null;
    this.dirty = new Set();
    this.listeners = new Set();
    this.watchers = new Map();
    this.signatures = new Map();
    this.closed = false;
    this.opened = false;
    this.syncing = null;
    this.again = false;
    this.debounce = null;
    this.timer = null;
    this.unsubscribeLocal = null;
    this.opening = null;
  }

  async open() {
    if (this.opened) return this;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      this.unsubscribeLocal = subscribeOrderChanges(this.home, event => this.localChange(event));
      await this.openWatchers();
      // Watcher callbacks may request a sync while initial recovery is reading.
      // Join that recovery instead of starting another full history read.
      this.syncing = this.runSync();
      try {
        await this.syncing;
      } finally {
        this.syncing = null;
      }
      if (this.again && !this.closed) {
        this.again = false;
        this.scheduleSync();
      }
      if (!this.closed) {
        this.timer = setInterval(() => { void this.sync(); }, this.fallbackInterval);
        this.timer.unref?.();
      }
      this.opened = true;
      return this;
    })();
    try { return await this.opening; }
    catch (error) {
      this.opening = null;
      this.unsubscribeLocal?.();
      this.unsubscribeLocal = null;
      this.closeWatchers();
      throw error;
    }
  }

  onChange(listener) {
    if (this.closed) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  all() {
    return [...this.entries.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.order_id.localeCompare(b.order_id));
  }

  pending(executor) {
    return [...this.entries.values()]
      .filter(entry => entry.executor === executor && !TERMINAL.has(entry.status))
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.order_id.localeCompare(b.order_id));
  }

  warnings() {
    const values = [...this.invalid.entries()].map(([id, message]) => `工作单 ${id.slice(0, 8)} 读取失败：${message}`);
    if (this.syncError) values.push(`工单目录同步失败：${this.syncError}`);
    return values;
  }

  sync() {
    if (this.closed) return Promise.resolve();
    if (this.syncing) { this.again = true; return this.syncing; }
    const running = this.runSync()
      .catch(error => { this.syncError = error?.message ?? String(error); })
      .finally(() => {
        this.syncing = null;
        if (this.again && !this.closed) {
          this.again = false;
          this.scheduleSync();
        }
      });
    this.syncing = running;
    return running;
  }

  async runSync() {
    const epoch = this.localEpoch;
    const ids = await listIds(this.requests);
    const changed = new Set();
    const present = new Set(ids);
    // A same-process change may have inserted an entry after this pass took
    // its directory snapshot. Deleting entries from that older snapshot would
    // hide live work until the next pass, so skip pruning when that raced.
    if (this.localEpoch === epoch) {
      for (const id of [...this.entries.keys()]) {
        if (!present.has(id)) { this.entries.delete(id); this.versions.delete(id); changed.add(id); }
      }
      for (const id of [...this.invalid.keys()]) if (!present.has(id)) { this.invalid.delete(id); this.versions.delete(id); }
    }
    const targets = new Set();
    for (const id of ids) if (!this.entries.has(id) && !this.invalid.has(id)) targets.add(id);
    for (const id of this.dirty) {
      this.dirty.delete(id);
      if (present.has(id)) targets.add(id);
    }
    // An unreadable order may only be transient (a concurrent replacement or a
    // short-lived EMFILE); retry it on later passes instead of hiding it until
    // some unrelated event happens to mention the same id.
    for (const id of this.invalid.keys()) if (present.has(id)) targets.add(id);
    // Unfinished states are re-read on every pass, including transitions made
    // by another process. Completed history is never reparsed without an event.
    for (const [id, entry] of this.entries) if (!TERMINAL.has(entry.status)) targets.add(id);
    await mapLimit([...targets], READ_CONCURRENCY, async id => { await this.load(id, changed); });
    await this.openWatchers();
    this.syncError = null;
    this.emit(changed);
  }

  async load(id, changed) {
    // A read started before a same-process transition must not write the older
    // state back: that could turn an executing order into queued and make the
    // consumer deliver it twice.
    const version = this.versions.get(id) ?? 0;
    const stale = () => (this.versions.get(id) ?? 0) !== version;
    let request;
    try { request = await readJson(join(this.requests, `${id}.json`)); }
    catch (error) {
      if (stale()) { this.dirty.add(id); return; }
      const previous = this.entries.get(id);
      this.entries.delete(id);
      this.invalid.set(id, error.message);
      if (previous) changed.add(id);
      return;
    }
    if (!request) {
      if (stale()) { this.dirty.add(id); return; }
      this.entries.delete(id);this.invalid.delete(id);changed.add(id);return;
    }
    let state = null;
    try { state = await readJson(join(this.states, `${id}.json`)); }
    catch (error) {
      if (stale()) { this.dirty.add(id); return; }
      const previous = this.entries.get(id);
      this.entries.delete(id);
      this.invalid.set(id, error.message);
      if (previous) changed.add(id);
      return;
    }
    if (stale()) { this.dirty.add(id); return; }
    const next = project(request, state);
    const previous = this.entries.get(id);
    this.entries.set(id, next);
    this.invalid.delete(id);
    if (!previous || !sameEntry(previous, next)) changed.add(id);
  }

  localChange(event) {
    if (this.closed || !event?.id) return;
    const id = event.id;
    this.localEpoch++;
    this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
    if (event.remove) {
      const had = this.entries.delete(id) || this.invalid.delete(id);
      if (had) this.emit(new Set([id]));
    } else if (event.request) {
      const previous = this.entries.get(id);
      if (previous && !event.state) { this.scheduleSync(); return; }
      const next = project(event.request, event.state ?? { status: 'queued' });
      this.entries.set(id, next);
      this.invalid.delete(id);
      if (!previous || !sameEntry(previous, next)) this.emit(new Set([id]));
    } else if (event.state) {
      const previous = this.entries.get(id);
      if (!previous) { this.dirty.add(id); }
      else {
        const next = {
          ...previous,
          status: event.state.status ?? previous.status,
          conversation_id: event.state.conversation_id ?? previous.conversation_id,
          updated_at: event.state.updated_at ?? previous.updated_at,
          model: event.state.route?.model ?? previous.model,
          provider: event.state.route?.provider ?? previous.provider,
          directory: event.state.directory ?? previous.directory,
        };
        this.entries.set(id, next);
        if (!sameEntry(previous, next)) this.emit(new Set([id]));
      }
    } else this.dirty.add(id);
    this.scheduleSync();
  }

  emit(ids) {
    if (!ids.size) return;
    for (const listener of [...this.listeners]) {
      try { listener({ ids: [...ids] }); } catch { /* a dead listener must not stop the index */ }
    }
  }

  scheduleSync() {
    if (this.closed || this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.sync();
    }, SYNC_DEBOUNCE_MS);
    this.debounce.unref?.();
  }

  onFileEvent(filename) {
    const name = typeof filename === 'string' ? filename : filename?.toString?.();
    if (name && UUID_FILE.test(name)) this.dirty.add(name.slice(0, -5));
    this.scheduleSync();
  }

  async openWatchers() {
    if (this.closed) return;
    for (const directory of [this.requests, this.states]) {
      let info;
      try { info = await stat(directory); }
      catch (error) { if (error.code === 'ENOENT') { this.closeWatcher(directory); continue; } throw error; }
      if (!info.isDirectory()) { this.closeWatcher(directory); continue; }
      const signature = `${info.dev}:${info.ino}`;
      if (this.watchers.has(directory) && this.signatures.get(directory) === signature) continue;
      // A rebuilt directory has a new identity; the old watcher stays attached
      // to the removed inode and would silently miss every later event.
      this.closeWatcher(directory);
      try {
        const watcher = watch(directory, { persistent: false }, (_type, filename) => this.onFileEvent(filename));
        watcher.on('error', () => {
          if (this.watchers.get(directory) === watcher) this.closeWatcher(directory);
        });
        watcher.on('close', () => {
          // A retired watcher may close after its replacement was installed.
          // Only remove the instance that actually owns this directory entry.
          if (this.watchers.get(directory) !== watcher) return;
          this.watchers.delete(directory);
          this.signatures.delete(directory);
        });
        this.watchers.set(directory, watcher);
        this.signatures.set(directory, signature);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  closeWatcher(directory) {
    const watcher = this.watchers.get(directory);
    if (watcher) { try { watcher.close(); } catch { /* already closed */ } }
    this.watchers.delete(directory);
    this.signatures.delete(directory);
  }

  closeWatchers() {
    for (const directory of [...this.watchers.keys()]) this.closeWatcher(directory);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.debounce) { clearTimeout(this.debounce); this.debounce = null; }
    this.unsubscribeLocal?.();
    this.unsubscribeLocal = null;
    this.closeWatchers();
    await this.syncing;
    this.listeners.clear();
    this.entries.clear();
    this.invalid.clear();
    this.versions.clear();
    this.syncError = null;
    this.dirty.clear();
  }
}

// Long-running services in one process share one index per data directory.
// The entry is removed as soon as its last user closes, so tests and short
// commands do not leave a global cache or watcher behind.
const registry = new Map();

export async function acquireOrderIndex(home, options) {
  const key = resolve(home);
  let record = registry.get(key);
  if (!record) {
    record = { refs: 0, index: null, opening: null };
    registry.set(key, record);
    record.opening = (async () => {
      const index = new OrderIndex(key, options);
      await index.open();
      record.index = index;
      return index;
    })();
    record.opening.catch(() => { if (record.refs === 0) registry.delete(key); });
  }
  record.refs++;
  try { return await record.opening; }
  catch (error) {
    record.refs--;
    if (record.refs <= 0) registry.delete(key);
    throw error;
  }
}

export async function releaseOrderIndex(index) {
  if (!index) return;
  const record = registry.get(index.home);
  if (!record || record.index !== index) { await index.close(); return; }
  record.refs--;
  if (record.refs > 0) return;
  registry.delete(index.home);
  await index.close();
}

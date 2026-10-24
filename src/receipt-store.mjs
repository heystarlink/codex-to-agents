import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';

// Persistent index for executor receipts. Receipt JSON files remain the single
// source of truth; this index only answers three questions without reading a
// completed body: which orders exist, which are unfinished, and where a native
// session lives (directory/route/permission). It is fully reconstructable from
// the receipt files, and a damaged or incomplete index falls back to one scan.
const VERSION = 1;
const INDEX_FILE = '.receipt-index.json';
const RECEIPT_FILE = /^([0-9a-f-]{36})\.json$/;

async function atomic(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

const stampOf = receipt => String(receipt?.updated_at ?? receipt?.started_at ?? '');

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nullableString = value => value === undefined || value === null || typeof value === 'string';

// The index is an optimization, never evidence: anything structurally wrong
// (including a single null entry) invalidates it and triggers one full scan.
function validIndex(value) {
  if (!isRecord(value) || value.version !== VERSION
      || !isRecord(value.orders) || !isRecord(value.sessions)) return false;
  for (const meta of Object.values(value.orders)) {
    if (!isRecord(meta) || typeof meta.active !== 'boolean'
        || !nullableString(meta.status)
        || !(meta.corrupt === undefined || typeof meta.corrupt === 'boolean')) return false;
  }
  for (const locator of Object.values(value.sessions)) {
    if (!isRecord(locator) || typeof locator.order_id !== 'string' || !locator.order_id) return false;
    if (!nullableString(locator.conversation_id)
        || !nullableString(locator.native_session_id)
        || !nullableString(locator.directory)
        || !nullableString(locator.status)
        || !nullableString(locator.updated_at)) return false;
    if (!(locator.route === undefined || locator.route === null || isRecord(locator.route))) return false;
    if (!(locator.permission === undefined || locator.permission === null
      || typeof locator.permission === 'string' || isRecord(locator.permission))) return false;
  }
  return true;
}

function locatorOf(orderId, receipt) {
  return {
    order_id: orderId,
    conversation_id: receipt.conversation_id ?? null,
    native_session_id: receipt.native_session_id ?? null,
    directory: receipt.directory ?? null,
    route: receipt.route ?? null,
    permission: receipt.permission ?? null,
    status: typeof receipt.status === 'string' ? receipt.status : null,
    updated_at: stampOf(receipt),
  };
}

const sameLocator = (left, right) => left.order_id === right.order_id
  && left.conversation_id === right.conversation_id
  && left.native_session_id === right.native_session_id
  && left.directory === right.directory
  && left.status === right.status
  && isDeepStrictEqual(left.route, right.route)
  && isDeepStrictEqual(left.permission, right.permission);

export class ReceiptStore {
  constructor(directory, { isTerminal, cacheSize = 32 } = {}) {
    if (typeof isTerminal !== 'function') throw new Error('ReceiptStore needs an isTerminal predicate.');
    this.directory = directory;
    this.indexPath = join(directory, INDEX_FILE);
    this.isTerminal = isTerminal;
    this.cacheSize = Number.isInteger(cacheSize) && cacheSize > 0 ? cacheSize : 32;
    this.orders = new Map();
    this.sessions = new Map();
    this.cache = new Map();
    this.stats = { receiptReads: 0, indexReads: 0 };
    this.indexError = null;
    this.indexDirty = false;
  }

  receiptPath(orderId) { return join(this.directory, `${orderId}.json`); }

  async readReceipt(orderId) {
    this.stats.receiptReads += 1;
    let raw;
    try { raw = await readFile(this.receiptPath(orderId), 'utf8'); }
    catch (error) {
      // Only a genuinely absent receipt is "no body". A transient I/O error
      // must reach the caller: converting it to null would let recovery mark a
      // still-active order inactive/corrupt and lose it forever.
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    try { return JSON.parse(raw); }
    catch { return null; }
  }

  async readIndex() {
    this.stats.indexReads += 1;
    let raw;
    // A missing or unreadable index is safe to rebuild: receipt bodies are the
    // source of truth and the scan revalidates every entry it produces.
    try { raw = await readFile(this.indexPath, 'utf8'); }
    catch { return null; }
    let value;
    try { value = JSON.parse(raw); }
    catch { return null; }
    return validIndex(value) ? value : null;
  }

  // Index one receipt. `preferNewest` keeps the locator of the latest turn for a
  // native session; migration and late crash reconciliation may visit receipts
  // in arbitrary order. Returns true when a persisted field changed.
  indexReceipt(orderId, receipt, { preferNewest = false } = {}) {
    let changed = false;
    const status = typeof receipt.status === 'string' ? receipt.status : null;
    const active = !status || !this.isTerminal(status);
    const current = this.orders.get(orderId);
    if (!current || current.active !== active || current.status !== status) {
      this.orders.set(orderId, { active, status });
      changed = true;
    }
    const sessionId = receipt.conversation_id ?? receipt.native_session_id ?? null;
    if (sessionId) {
      const next = locatorOf(orderId, receipt);
      const existing = this.sessions.get(sessionId);
      const superseded = preferNewest && existing
        && String(existing.updated_at ?? '') > next.updated_at;
      if (!superseded) {
        if (!existing || !sameLocator(existing, next)) {
          this.sessions.set(sessionId, next);
          changed = true;
        } else if (existing.updated_at !== next.updated_at) {
          // Progress-only saves may advance the timestamp without changing any
          // recovery-relevant locator field. Keep it in memory, not on disk.
          existing.updated_at = next.updated_at;
        }
      }
    }
    // A follow-up can resume session A and then report a brand-new native
    // session B. The alias for A must follow the order's current status instead
    // of staying frozen at "starting"; otherwise a restart would see a finished
    // conversation as still dispatchable.
    for (const [aliasId, alias] of this.sessions) {
      if (aliasId === sessionId || alias.order_id !== orderId || alias.status === status) continue;
      alias.status = status;
      changed = true;
    }
    return changed;
  }

  remember(receipt) {
    const id = receipt?.order_id;
    if (!id) return;
    this.cache.delete(id);
    this.cache.set(id, receipt);
    while (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value);
  }

  async writeIndex() {
    const value = {
      version: VERSION,
      updated_at: new Date().toISOString(),
      orders: Object.fromEntries(this.orders),
      sessions: Object.fromEntries(this.sessions),
    };
    await atomic(this.indexPath, value);
  }

  // Receipt first, index second. A crash in between leaves the index behind,
  // which open() reconciles from the receipt itself; a failed index write must
  // never fail a receipt that was already saved.
  async commit(receipt, orderId = receipt.order_id) {
    const snapshot = structuredClone(receipt);
    await atomic(this.receiptPath(orderId), snapshot);
    this.remember(snapshot);
    const changed = this.indexReceipt(orderId, snapshot, { preferNewest: true });
    this.indexDirty ||= changed;
    if (!this.indexDirty) return;
    try {
      await this.writeIndex();
      this.indexDirty = false;
      this.indexError = null;
    } catch (error) {
      this.indexError = error;
      this.indexDirty = true;
    }
  }

  async get(orderId) {
    if (this.cache.has(orderId)) {
      const cached = this.cache.get(orderId);
      this.cache.delete(orderId);
      this.cache.set(orderId, cached);
      return cached;
    }
    const receipt = await this.readReceipt(orderId);
    if (receipt) this.remember(receipt);
    return receipt;
  }

  hasOrder(orderId) { return this.orders.has(orderId); }

  // Current status of an order, including released terminal receipts. Older
  // session aliases (a follow-up that changed its native session) must consult
  // this rather than their frozen locator snapshot.
  order(orderId) { return this.orders.get(orderId) ?? null; }

  hasSession(sessionId) { return this.sessions.has(sessionId); }

  session(sessionId) { return this.sessions.get(sessionId) ?? null; }

  dropSessionFor(orderId) {
    let changed = false;
    for (const [sessionId, locator] of this.sessions) {
      if (locator.order_id !== orderId) continue;
      this.sessions.delete(sessionId);
      changed = true;
    }
    return changed;
  }

  // One-time migration for installations that only have receipt JSON files.
  // Unfinished bodies are handed back so open() does not read them a second time.
  async scanAll() {
    this.orders = new Map();
    this.sessions = new Map();
    const bodies = new Map();
    for (const name of await readdir(this.directory)) {
      const match = RECEIPT_FILE.exec(name);
      if (!match) continue;
      const orderId = match[1];
      const receipt = await this.readReceipt(orderId);
      if (!receipt) {
        this.orders.set(orderId, { active: false, status: null, corrupt: true });
        continue;
      }
      this.indexReceipt(orderId, receipt, { preferNewest: true });
      if (!this.isTerminal(receipt.status)) bodies.set(orderId, receipt);
    }
    return bodies;
  }

  // Restore only unfinished receipts. Completed bodies stay on disk and are
  // loaded on demand by get(). Returns the receipts the adapter must hold.
  async open() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stored = await this.readIndex();
    let changed = false;
    let bodies;
    if (stored) {
      this.orders = new Map(Object.entries(stored.orders));
      this.sessions = new Map(Object.entries(stored.sessions));
      bodies = new Map();
    } else {
      bodies = await this.scanAll();
      changed = true;
    }

    const present = new Set();
    for (const name of await readdir(this.directory)) {
      const match = RECEIPT_FILE.exec(name);
      if (match) present.add(match[1]);
    }

    const read = async orderId => {
      if (!bodies.has(orderId)) bodies.set(orderId, await this.readReceipt(orderId));
      return bodies.get(orderId);
    };

    // Narrow crash window: the receipt was saved but the index write did not
    // happen. Reading only these unknown files keeps a warm start at zero
    // completed-body reads.
    for (const orderId of present) {
      if (this.orders.has(orderId)) continue;
      const receipt = await read(orderId);
      changed = true;
      if (!receipt) {
        this.orders.set(orderId, { active: false, status: null, corrupt: true });
        continue;
      }
      this.indexReceipt(orderId, receipt, { preferNewest: true });
      if (this.isTerminal(receipt.status)) this.remember(receipt);
    }

    const restored = [];
    for (const [orderId, meta] of [...this.orders]) {
      if (!meta.active) continue;
      if (!present.has(orderId)) {
        this.orders.delete(orderId);
        this.dropSessionFor(orderId);
        changed = true;
        continue;
      }
      const receipt = await read(orderId);
      if (!receipt) {
        meta.active = false;
        meta.corrupt = true;
        changed = true;
        continue;
      }
      if (this.isTerminal(receipt.status)) {
        this.indexReceipt(orderId, receipt, { preferNewest: true });
        this.remember(receipt);
        changed = true;
        continue;
      }
      this.indexReceipt(orderId, receipt, { preferNewest: true });
      restored.push(receipt);
    }

    if (changed) {
      try {
        await this.writeIndex();
        this.indexError = null;
      } catch (error) { this.indexError = error; }
    }
    return restored;
  }

  close() {
    this.cache.clear();
  }
}

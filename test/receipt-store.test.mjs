import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Qoder } from '../src/qoder.mjs';
import { Hermes } from '../src/hermes.mjs';
import { ReceiptStore } from '../src/receipt-store.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'blocked']);
const terminal = status => TERMINAL.has(status);

async function home(t, prefix = 'cta-receipt-store-') {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(directory, { recursive: true, force: true }).catch(() => {}));
  return directory;
}

function qoderReceipt(orderId, status, { session, text = '', permission = 'accept_edits', directory = '/tmp/project' } = {}) {
  return {
    order_id: orderId, directory, route: { provider: 'qoder', model: 'DeepSeek-V4-Pro' },
    native_session_id: session ?? null, conversation_id: session ?? null, permission,
    status, progress: text || status, text: text || status,
    output: { text: text || status, native_status: 'success', terminal_confirmed: terminal(status), exit_confirmed: terminal(status) },
    started_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:01.000Z',
  };
}

function hermesReceipt(orderId, status, { session, text = '', permission = { preset: 'yolo', scope: 'session', readback: 'session.info', effective_yolo: true } } = {}) {
  return {
    order_id: orderId, conversation_id: session ?? `stored-${orderId}`, native_session_id: `live-${orderId}`,
    permission, status, progress: text || status, text: text || status,
    output: { text: text || status, native_status: status, conversation_id: session ?? `stored-${orderId}` },
    started_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:01.000Z',
  };
}

const neverSpawn = () => { throw new Error('storage open must never spawn a CLI'); };

test('Qoder: second open reads zero completed receipt bodies, memory stays empty and on-demand reads are bounded', async t => {
  const root = await home(t);
  const dir = join(root, 'qoder-receipts');
  await mkdir(dir, { recursive: true });
  const ids = [];
  for (let index = 0; index < 1000; index += 1) {
    const id = randomUUID();ids.push(id);
    await writeFile(join(dir, `${id}.json`), JSON.stringify(qoderReceipt(id, 'completed', {
      session: `session-${index}`, text: `completed result ${index} `.repeat(80),
    })));
  }

  const first = new Qoder({ home: root, spawn: neverSpawn, receiptCacheSize: 8 });
  await first.open();
  assert.equal(first.turns.size, 0, 'completed receipts must not be resident in turns');
  assert.equal(first.processes.size, 0);
  assert.equal(first.store.stats.receiptReads, 1000, 'the one-time migration may scan all old bodies');
  assert.ok(await readFile(join(dir, `${ids[0]}.json`), 'utf8'));

  const second = new Qoder({ home: root, spawn: neverSpawn, receiptCacheSize: 8 });
  await second.open();
  assert.equal(second.store.stats.receiptReads, 0, 'a warm start must not read completed bodies');
  assert.equal(second.turns.size, 0);
  assert.equal(second.processes.size, 0);

  const readsBeforeCheckpoint = second.store.stats.receiptReads;
  const locator = await second.checkpoint('session-500');
  assert.equal(second.store.stats.receiptReads, readsBeforeCheckpoint, 'checkpoint resolves from the locator index');
  assert.equal(locator.directory, '/tmp/project');
  assert.deepEqual(locator.route, { provider: 'qoder', model: 'DeepSeek-V4-Pro' });
  assert.equal(locator.permission, 'accept_edits');

  const readsBeforeCancel = second.store.stats.receiptReads;
  assert.deepEqual(await second.cancel('session-500'),
    { cancelled: false, already_terminal: true, conversation_id: 'session-500', native_queue_cleared: false });
  assert.equal(second.store.stats.receiptReads, readsBeforeCancel, 'cancelling an old completed session reads no body');

  const done = await second.progress({ id: ids[3] }, { status: 'executing' });
  assert.equal(done.status, 'completed');
  assert.match(done.output.text, /completed result 3/);
  assert.equal(second.store.stats.receiptReads, 1, 'a displaced terminal body is read once on demand');
  assert.ok(second.store.cache.size <= 8);

  for (const id of ids.slice(10, 300)) await second.progress({ id }, { status: 'executing' });
  assert.ok(second.store.cache.size <= 8, 'the on-demand body cache is bounded');
  assert.equal((await readdir(dir)).filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).length, 1000,
    'no user history file is deleted');
});

test('Hermes: second open reads zero completed receipt bodies and keeps no terminal results resident', async t => {
  const root = await home(t, 'cta-receipt-hermes-');
  const dir = join(root, 'hermes-receipts');
  await mkdir(dir, { recursive: true });
  for (let index = 0; index < 500; index += 1) {
    const id = randomUUID();
    await writeFile(join(dir, `${id}.json`), JSON.stringify(hermesReceipt(id, 'completed', { session: `stored-${index}`, text: `result ${index} `.repeat(40) })));
  }
  const first = new Hermes({ home: root, receiptCacheSize: 4 });
  await first.open();
  assert.equal(first.turns.size, 0);
  assert.equal(first.store.stats.receiptReads, 500);

  const second = new Hermes({ home: root, receiptCacheSize: 4 });
  await second.open();
  assert.equal(second.store.stats.receiptReads, 0);
  assert.equal(second.turns.size, 0);
  assert.equal(second.store.session('stored-7').permission.preset, 'yolo');
  assert.equal(second.store.stats.receiptReads, 0, 'the stored session permission is indexed, not re-read');
});

test('Qoder: only unfinished receipts are restored, an interrupted turn stays uncertain and is never replayed', async t => {
  const root = await home(t, 'cta-receipt-active-');
  const dir = join(root, 'qoder-receipts');
  await mkdir(dir, { recursive: true });
  const done = randomUUID();
  const running = randomUUID();
  await writeFile(join(dir, `${done}.json`), JSON.stringify(qoderReceipt(done, 'completed', { session: 'old-session' })));
  await writeFile(join(dir, `${running}.json`), JSON.stringify(qoderReceipt(running, 'executing', {
    session: 'live-session', text: 'partial output', permission: 'dont_ask',
  })));

  const adapter = new Qoder({ home: root, spawn: neverSpawn });
  await adapter.open();
  assert.deepEqual([...adapter.turns.keys()], [running]);
  assert.equal(adapter.turns.get(running).status, 'uncertain');
  assert.match(adapter.turns.get(running).progress, /不会自动重放/);
  assert.equal(adapter.processes.size, 0);

  const locator = await adapter.checkpoint('live-session');
  assert.equal(locator.permission, 'dont_ask');
  assert.equal(adapter.store.stats.receiptReads, 2, 'one migration scan plus the one active receipt read');
});

test('a crash between the terminal receipt write and the index update recovers without losing or faking the result', async t => {
  const root = await home(t, 'cta-receipt-crash-');
  const dir = join(root, 'qoder-receipts');
  const first = new ReceiptStore(dir, { isTerminal: terminal, cacheSize: 4 });
  await first.open();
  const active = qoderReceipt(randomUUID(), 'executing', { session: 's-1' });
  await first.commit(active);
  assert.equal(first.hasOrder(active.order_id), true);

  // The receipt is the source of truth: a failed index write must not fail the
  // save, and a restart must reconcile the stale "active" marker.
  first.writeIndex = async () => { throw new Error('simulated partial index write'); };
  const finished = { ...active, status: 'completed', progress: 'finished', updated_at: '2026-01-01T00:00:02.000Z' };
  await first.commit(finished);
  assert.equal(JSON.parse(await readFile(join(dir, `${active.order_id}.json`), 'utf8')).status, 'completed');

  const second = new ReceiptStore(dir, { isTerminal: terminal, cacheSize: 4 });
  const restored = await second.open();
  assert.deepEqual(restored, [], 'the recovered terminal receipt is not restored as unfinished');
  assert.equal(second.session('s-1').status, 'completed');

  const third = new ReceiptStore(dir, { isTerminal: terminal, cacheSize: 4 });
  await third.open();
  assert.equal(third.stats.receiptReads, 0, 'the reconciled index is warm after one recovery');
});

test('an index write failure on a fresh receipt still leaves a recoverable fact on disk', async t => {
  const root = await home(t, 'cta-receipt-index-fail-');
  const dir = join(root, 'qoder-receipts');
  const first = new ReceiptStore(dir, { isTerminal: terminal, cacheSize: 4 });
  await first.open();
  const active = qoderReceipt(randomUUID(), 'executing', { session: 's-crash' });
  first.writeIndex = async () => { throw new Error('index unavailable'); };
  await first.commit(active);
  assert.equal(JSON.parse(await readFile(join(dir, `${active.order_id}.json`), 'utf8')).status, 'executing');

  const second = new ReceiptStore(dir, { isTerminal: terminal, cacheSize: 4 });
  const restored = await second.open();
  assert.deepEqual(restored.map(receipt => receipt.order_id), [active.order_id],
    'the unindexed receipt is discovered on the next start');
});

test('corrupt index and corrupt active receipts never break recovery or delete history', async t => {
  const root = await home(t, 'cta-receipt-corrupt-');
  const dir = join(root, 'qoder-receipts');
  await mkdir(dir, { recursive: true });
  const completed = randomUUID();
  const active = randomUUID();
  const corrupt = randomUUID();
  await writeFile(join(dir, `${completed}.json`), JSON.stringify(qoderReceipt(completed, 'completed', { session: 'done-session' })));
  await writeFile(join(dir, `${active}.json`), JSON.stringify(qoderReceipt(active, 'starting', { session: 'starting-session' })));
  await writeFile(join(dir, `${corrupt}.json`), '{not json');
  await writeFile(join(dir, '.receipt-index.json'), '{"version":1,"orders":');

  const adapter = new Qoder({ home: root, spawn: neverSpawn });
  await adapter.open();
  assert.deepEqual([...adapter.turns.keys()], [active]);
  assert.equal(adapter.turns.get(active).status, 'uncertain');
  assert.equal(await readFile(join(dir, `${corrupt}.json`), 'utf8'), '{not json', 'corrupt history is preserved untouched');

  const second = new Qoder({ home: root, spawn: neverSpawn });
  await second.open();
  // The active receipt is read once per start; the corrupt file is remembered
  // as known and is not parsed again.
  assert.equal(second.store.stats.receiptReads, 1);
  assert.deepEqual([...second.turns.keys()], [active]);
});

test('a structurally damaged index entry falls back to one scan instead of crashing or trusting it', async t => {
  const root = await home(t, 'cta-receipt-bad-index-');
  const dir = join(root, 'qoder-receipts');
  await mkdir(dir, { recursive: true });
  const active = randomUUID();
  await writeFile(join(dir, `${active}.json`), JSON.stringify(qoderReceipt(active, 'executing', { session: 's-bad-index' })));
  const index = join(dir, '.receipt-index.json');
  const damaged = [
    { version: 1, orders: { [active]: null }, sessions: {} },
    { version: 1, orders: {}, sessions: { 's-bad-index': null } },
    { version: 1, orders: { [active]: { active: 'yes', status: 'executing' } }, sessions: {} },
    { version: 1, orders: {}, sessions: { 's-bad-index': { status: 'executing' } } },
    { version: 1, orders: { [active]: [] }, sessions: { 's-bad-index': 'locator' } },
  ];
  for (const value of damaged) {
    await writeFile(index, JSON.stringify(value));
    const store = new ReceiptStore(dir, { isTerminal: terminal, cacheSize: 4 });
    const restored = await store.open();
    assert.deepEqual(restored.map(receipt => receipt.order_id), [active], 'a damaged index must be rebuilt from receipt files');
    assert.equal(store.session('s-bad-index').status, 'executing', 'the session locator is rebuilt too');
    const repaired = JSON.parse(await readFile(index, 'utf8'));
    assert.equal(repaired.orders[active].active, true);
    assert.equal(repaired.sessions['s-bad-index'].order_id, active);
  }
});

test('a transient receipt read failure is never persisted as an inactive/corrupt index entry', async t => {
  const root = await home(t, 'cta-receipt-transient-');
  const dir = join(root, 'qoder-receipts');
  const store = new ReceiptStore(dir, { isTerminal: terminal, cacheSize: 4 });
  await store.open();
  const active = qoderReceipt(randomUUID(), 'executing', { session: 's-transient' });
  await store.commit(active);
  const path = join(dir, `${active.order_id}.json`);
  const body = await readFile(path, 'utf8');

  // A directory at the receipt path raises EISDIR (a non-ENOENT read error),
  // which stands in for any transient I/O failure without patching globals.
  await rm(path);
  await mkdir(path);
  const failing = new ReceiptStore(dir, { isTerminal: terminal, cacheSize: 4 });
  await assert.rejects(failing.open(), error => error.code === 'EISDIR');
  const persisted = JSON.parse(await readFile(join(dir, '.receipt-index.json'), 'utf8'));
  assert.equal(persisted.orders[active.order_id].active, true,
    'a transient I/O error must not be written as a finished/corrupt order');
  assert.notEqual(persisted.orders[active.order_id].corrupt, true);

  await rm(path, { recursive: true, force: true });
  await writeFile(path, body);
  const recovered = new ReceiptStore(dir, { isTerminal: terminal, cacheSize: 4 });
  assert.deepEqual((await recovered.open()).map(receipt => receipt.order_id), [active.order_id],
    'the still-active receipt is restored once the disk recovers');
});

test('on-demand reads expose transient errors but still report genuinely missing or malformed bodies', async t => {
  const root = await home(t, 'cta-receipt-on-demand-');
  const dir = join(root, 'qoder-receipts');
  const writer = new ReceiptStore(dir, { isTerminal: terminal, cacheSize: 4 });
  await writer.open();
  const active = qoderReceipt(randomUUID(), 'executing', { session: 's-demand' });
  await writer.commit(active);
  const path = join(dir, `${active.order_id}.json`);
  const body = await readFile(path, 'utf8');

  const reader = new ReceiptStore(dir, { isTerminal: terminal, cacheSize: 4 });
  assert.equal(await reader.get(randomUUID()), null, 'ENOENT is a genuinely absent body');
  await writeFile(path, '{not json');
  assert.equal(await reader.get(active.order_id), null, 'a malformed body is reported as unreadable, not thrown');

  await writeFile(path, body);
  await rm(path);
  await mkdir(path);
  await assert.rejects(reader.get(active.order_id), error => error.code === 'EISDIR',
    'a transient I/O error must reach the caller instead of masquerading as a missing receipt');

  await rm(path, { recursive: true, force: true });
  await writeFile(path, body);
  assert.equal((await reader.get(active.order_id)).order_id, active.order_id);
});

test('an indexed active marker whose receipt disappeared is pruned instead of blocking startup', async t => {
  const root = await home(t, 'cta-receipt-missing-');
  const dir = join(root, 'qoder-receipts');
  const store = new ReceiptStore(dir, { isTerminal: terminal, cacheSize: 4 });
  await store.open();
  const active = qoderReceipt(randomUUID(), 'executing', { session: 'gone-session' });
  await store.commit(active);
  await rm(join(dir, `${active.order_id}.json`));

  const next = new ReceiptStore(dir, { isTerminal: terminal, cacheSize: 4 });
  assert.deepEqual(await next.open(), []);
  assert.equal(next.hasOrder(active.order_id), false);
  assert.equal(next.session('gone-session'), null);
});

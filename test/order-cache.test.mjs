import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { OrderBook } from '../src/orders.mjs';
import { Consumer, startConsumer } from '../src/worker.mjs';
import { acquireOrderIndex, releaseOrderIndex } from '../src/order-cache.mjs';
import { lazyExecutor } from '../src/executor-loader.mjs';

const ordersModule = pathToFileURL(fileURLToPath(new URL('../src/orders.mjs', import.meta.url))).href;

async function environment(t) {
  const home = await mkdtemp('/tmp/cta-index-');
  const book = new OrderBook(home);await book.open();
  const sent = [];
  const operations = [];
  const counters = { observe: 0, progress: 0 };
  const desktop = {
    async describe() { return { models: [] }; },
    observe(ids) { counters.observe++;return ids.map(id => ({ id, status: 'idle' })); },
    async start(order) { return { conversation_id: `cw-${order.id}`, checkpoint: 0 }; },
    async send(order, location, message) { sent.push({ id: order.id, location, message }); },
    async checkpoint(id) { return { conversation_id: id, checkpoint: 1 }; },
    async progress() { counters.progress++;return { status: 'executing', progress: 'waiting' }; },
    async cancel(id) { operations.push({ cancelled: id }); },
  };
  const consumers = [];
  const consumer = async (options = {}) => {
    const value = new Consumer(home, desktop, { executor: 'dsh', heartbeatInterval: 250, ...options });
    await value.open();
    consumers.push(value);
    return value;
  };
  const indexes = [];
  const index = async options => {
    const value = await acquireOrderIndex(home, options);
    indexes.push(value);
    return value;
  };
  t.after(async () => {
    for (const value of consumers.reverse()) await value.close();
    for (const value of indexes.reverse()) await releaseOrderIndex(value);
    await rm(home, { recursive: true, force: true });
  });
  return { home, book, desktop, sent, operations, counters, consumer, index };
}

async function waitFor(predicate, timeoutMs = 4000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return Date.now();
    await delay(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function runChild(script) {
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
  let error = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { error += chunk; });
  const closed = new Promise(resolve => child.once('close', code => resolve({ code, error })));
  return { child, closed };
}

test('the index restores completed history once and keeps only bounded metadata', async t => {
  const f = await environment(t);
  const marker = 'OUTPUT-MARKER-' + 'x'.repeat(200000);
  for (let index = 0; index < 2; index++) {
    const order = await f.book.submit('work_submit', { executor: 'dsh', goal: `done ${index}` });
    await f.book.transition(order.order_id, 'completed', { output: { text: marker } });
  }
  const first = await f.index();
  assert.equal(first.all().length, 2);
  assert.equal(first.pending('dsh').length, 0);
  for (const entry of first.all()) {
    assert.ok(JSON.stringify(entry).length < 1000, 'metadata projection stays small');
    assert.ok(!JSON.stringify(entry).includes('OUTPUT-MARKER'), 'output bodies are never cached');
  }
  const second = await f.index();
  assert.equal(second, first, 'long-running services share one index per home');
  await releaseOrderIndex(first);
  await releaseOrderIndex(second);
  const restored = await f.index();
  assert.notEqual(restored, first, 'the registry drops the entry when the last user closes');
  assert.equal(restored.all().length, 2, 'history is restored from disk after the last user leaves');
});

test('a same-process submission wakes an otherwise idle consumer immediately', async t => {
  const f = await environment(t);
  const worker = await f.consumer({ activeInterval: 5000, idleInterval: 5000 });
  worker.start({ activeInterval: 5000, idleInterval: 5000 });
  await delay(120);
  assert.ok(f.counters.observe <= 1, 'no polling should explain the wake up');

  const started = Date.now();
  const order = await new OrderBook(f.home).submit('work_submit', { goal: 'wake up' });
  await waitFor(() => f.sent.some(item => item.id === order.order_id), 1000, 'same-process dispatch');
  assert.ok(Date.now() - started < 1000);
  await delay(150);
  assert.equal(f.sent.filter(item => item.id === order.order_id).length, 1, 'the wake must not duplicate the delivery');
});

test('a submission from another process is discovered within the bounded fallback window', async t => {
  const f = await environment(t);
  const worker = await f.consumer({ activeInterval: 5000, idleInterval: 5000, fallbackInterval: 400 });
  worker.start({ activeInterval: 5000, idleInterval: 5000 });
  await delay(100);

  const id = randomUUID();
  const started = Date.now();
  const child = runChild(`import(${JSON.stringify(ordersModule)}).then(async ({ OrderBook }) => {
    const book = new OrderBook(${JSON.stringify(f.home)});
    await book.open();
    await book.submit('work_submit', { order_id: ${JSON.stringify(id)}, goal: 'from another process' });
  })`);
  t.after(() => { if (child.child.exitCode === null) child.child.kill(); });
  await waitFor(() => f.sent.some(item => item.id === id), 3000, 'cross-process dispatch');
  const { code, error } = await child.closed;
  assert.equal(code, 0, error);
  assert.ok(Date.now() - started < 3000, 'cross-process work appears well inside the online threshold');
  assert.equal(f.sent.filter(item => item.id === id).length, 1);
  await waitFor(async () => (await f.book.inspect(id))?.status === 'executing', 1000, 'dispatch receipt');
});

test('a cross-process terminal change is visible even when the watcher event is missed', async t => {
  const f = await environment(t);
  const order = await f.book.submit('work_submit', { goal: 'finish elsewhere' });
  const index = await f.index({ fallbackInterval: 250 });
  assert.equal(index.pending('dsh').length, 1);
  index.closeWatchers();

  const child = runChild(`import(${JSON.stringify(ordersModule)}).then(async ({ OrderBook }) => {
    const book = new OrderBook(${JSON.stringify(f.home)});
    await book.transition(${JSON.stringify(order.order_id)}, 'completed', { output: { text: 'elsewhere' } });
  })`);
  await waitFor(() => index.pending('dsh').length === 0, 2500, 'fallback reconciliation');
  const { code, error } = await child.closed;
  assert.equal(code, 0, error);
  assert.equal(index.all().find(entry => entry.order_id === order.order_id).status, 'completed');
  assert.equal((await f.book.inspect(order.order_id)).output.text, 'elsewhere');
});

test('rebuilt data directories are detected and watched again', async t => {
  const f = await environment(t);
  const old = await f.book.submit('work_submit', { goal: 'before rebuild' });
  const index = await f.index({ fallbackInterval: 250 });
  assert.equal(index.pending('dsh').length, 1);

  await rename(join(f.home, 'requests'), join(f.home, 'requests.replaced'));
  await mkdir(join(f.home, 'requests'));
  const next = randomUUID();
  const child = runChild(`import(${JSON.stringify(ordersModule)}).then(async ({ OrderBook }) => {
    const book = new OrderBook(${JSON.stringify(f.home)});
    await book.submit('work_submit', { order_id: ${JSON.stringify(next)}, goal: 'after rebuild' });
  })`);
  await waitFor(() => index.pending('dsh').some(entry => entry.order_id === next), 2500, 'new directory identity');
  const { code, error } = await child.closed;
  assert.equal(code, 0, error);
  assert.ok(!index.all().some(entry => entry.order_id === old.order_id), 'removed requests leave the index');
  await waitFor(async () => index.pending('dsh').length === 1, 1000, 'watcher reopened');
  await rm(join(f.home, 'requests.replaced'), { recursive: true, force: true });
});

test('different homes never share index entries or notifications', async t => {
  const f = await environment(t);
  const otherHome = await mkdtemp('/tmp/cta-index-other-');
  t.after(() => rm(otherHome, { recursive: true, force: true }));
  const index = await f.index();
  const other = new OrderBook(otherHome);await other.open();
  await other.submit('work_submit', { goal: 'unrelated home' });
  await delay(200);
  assert.equal(index.all().length, 0);
  await other.submit('work_submit', { goal: 'same process, different home' });
  await delay(100);
  assert.equal(index.all().length, 0);
});

test('the heartbeat keeps publishing while processing is blocked and while idle', async t => {
  const f = await environment(t);
  const order = await f.book.submit('work_submit', { goal: 'long native call' });
  await f.book.transition(order.order_id, 'executing', { conversation_id: 'cw-slow', progress: 'running' });
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let blockedOnce = false;
  f.desktop.observe = async ids => {
    f.counters.observe++;
    if (!blockedOnce) { blockedOnce = true;await blocked; }
    return ids.map(id => ({ id, status: 'idle' }));
  };
  const worker = await f.consumer({ heartbeatInterval: 100, activeInterval: 50 });
  worker.start({ heartbeatInterval: 100, activeInterval: 50 });

  const beats = new Set();let maxAge = 0;
  const sampling = (async () => {
    const deadline = Date.now() + 700;
    while (Date.now() < deadline) {
      const runtime = await f.book.runtime(null, 'dsh');
      if (runtime.snapshot?.at) {
        beats.add(runtime.snapshot.at);
        maxAge = Math.max(maxAge, Date.now() - Date.parse(runtime.snapshot.at));
      }
      await delay(40);
    }
  })();
  await delay(450);
  release();
  await sampling;
  assert.ok(beats.size >= 3, `expected several independent heartbeats, saw ${beats.size}`);
  assert.ok(maxAge < 600, `heartbeat age ${maxAge} ms must stay far below the 6 s online threshold`);

  await f.book.transition(order.order_id, 'completed');
  await waitFor(() => f.counters.observe >= 2, 1000, 'idle transition');
  const idleBeats = new Set();
  const idleDeadline = Date.now() + 450;
  while (Date.now() < idleDeadline) {
    const runtime = await f.book.runtime(null, 'dsh');
    if (runtime.snapshot?.at) idleBeats.add(runtime.snapshot.at);
    await delay(40);
  }
  assert.ok(idleBeats.size >= 3, 'the heartbeat is independent of pending work');
});

test('polling slows down when no work is unfinished', async t => {
  const f = await environment(t);
  const order = await f.book.submit('work_submit', { goal: 'active then idle' });
  await f.book.transition(order.order_id, 'executing', { conversation_id: 'cw-poll', progress: 'running' });
  const worker = await f.consumer({ activeInterval: 50, idleInterval: 800 });
  worker.start({ activeInterval: 50, idleInterval: 800 });
  await delay(300);
  const active = f.counters.observe;
  assert.ok(active >= 3, `expected active polling, saw ${active} passes`);

  f.desktop.progress = async () => ({ status: 'completed', progress: 'done' });
  await waitFor(async () => (await f.book.inspect(order.order_id)).status === 'completed', 1000, 'consumer completion');
  await delay(160);
  const before = f.counters.observe;
  await delay(350);
  const idle = f.counters.observe - before;
  assert.ok(idle <= 1, `idle polling must be cheaper, saw ${idle} passes in 350 ms`);
});

test('an uncertain order is followed without a replay and can still finish', async t => {
  const f = await environment(t);
  const order = await f.book.submit('work_submit', { goal: 'uncertain delivery' });
  await f.book.transition(order.order_id, 'dispatching', { conversation_id: `cw-${order.order_id}` });
  const worker = await f.consumer({ activeInterval: 30, idleInterval: 100 });
  assert.equal((await f.book.inspect(order.order_id)).status, 'uncertain');
  f.desktop.progress = async () => {
    f.counters.progress++;
    return { status: 'uncertain', progress: 'still inspecting native history' };
  };
  await worker.tick();
  await worker.tick();
  assert.equal((await f.book.inspect(order.order_id)).status, 'uncertain');
  assert.equal(f.sent.length, 0, 'uncertain work is never automatically replayed');
  assert.ok(f.counters.progress >= 2, 'uncertain work keeps being followed');

  f.desktop.progress = async () => ({ status: 'completed', progress: 'done', output: { text: 'native result' } });
  await worker.tick();
  const result = await f.book.inspect(order.order_id);
  assert.equal(result.status, 'completed');
  assert.equal(result.output.text, 'native result');
  assert.equal(f.sent.length, 0);
});

test('a temporarily unreadable order is retried instead of staying hidden', async t => {
  const f = await environment(t);
  const order = await f.book.submit('work_submit', { goal: 'transient read failure' });
  const index = await f.index({ fallbackInterval: 200 });
  assert.equal(index.all().length, 1);
  const path = join(f.home, 'requests', `${order.order_id}.json`);
  const original = await readFile(path, 'utf8');

  index.closeWatchers();
  await writeFile(path, '{ not json');
  await waitFor(() => index.warnings().length > 0 && index.all().length === 0, 2500, 'unreadable warning');

  index.closeWatchers();
  await writeFile(path, original);
  await waitFor(() => index.all().length === 1, 2500, 'index retry after the file recovers');
  assert.equal(index.warnings().length, 0);
  assert.equal(index.pending('dsh').length, 1);
});

test('the lazy loader ignores completed history and starts only for unfinished work', async t => {
  const f = await environment(t);
  const done = await f.book.submit('work_submit', { executor: 'hermes', goal: 'old work' });
  await f.book.transition(done.order_id, 'completed');
  await f.book.atomic(join(f.home, 'settings.json'), { hermes: { url: 'http://127.0.0.1:1', defaultDirectory: f.home } });
  const loads = [];
  let closedWorker = false;
  const loader = lazyExecutor(f.home, {
    executor: 'hermes', settingsKey: 'hermes', interval: 60000,
    load: async () => {
      loads.push(Date.now());
      return { startExecutorWorker: () => ({ ready: Promise.resolve(), async close() { closedWorker = true; } }) };
    },
  });
  t.after(() => loader.close());
  await loader.check();
  await loader.check();
  assert.equal(loads.length, 0);
  assert.equal(loader.state.loaded, false);

  await f.book.submit('work_submit', { executor: 'hermes', goal: 'new work' });
  await loader.check();
  await loader.check();
  assert.equal(loads.length, 1, 'the worker starts once and is reused');
  assert.equal(loader.state.loaded, true);
  await loader.close();
  assert.equal(closedWorker, true);
});

test('a failed observation goes offline but keeps the cached model catalog', async t => {
  const f = await environment(t);
  f.desktop.describe = async () => ({ models: [{ provider: 'account', model: 'flash' }] });
  const order = await f.book.submit('work_submit', { goal: 'native outage' });
  const worker = await f.consumer({ activeInterval: 30, idleInterval: 100 });
  await worker.tick();
  assert.equal(f.sent.length, 1);

  f.desktop.observe = async () => { throw new Error('native session service unavailable'); };
  await worker.tick();
  const offline = await f.book.runtime(null, 'dsh');
  assert.equal(offline.online, false);
  assert.match(offline.snapshot.catalog.error, /unavailable/);
  assert.deepEqual(offline.snapshot.catalog.models, [{ provider: 'account', model: 'flash' }], 'the last catalog survives a transient outage');

  f.desktop.observe = ids => ids.map(id => ({ id, status: 'idle' }));
  await worker.tick();
  const recovered = await f.book.runtime(null, 'dsh');
  assert.equal(recovered.online, true);
  assert.equal(recovered.snapshot.catalog.error, undefined);
  assert.equal(f.sent.length, 1, 'recovery never replays the delivered order');
  assert.equal((await f.book.inspect(order.order_id)).status, 'executing');
});

test('the shared consumer runner retries a failing factory instead of keeping a dead lease', async t => {
  const f = await environment(t);
  const order = await f.book.submit('work_submit', { goal: 'retry startup' });
  let attempts = 0;
  const worker = startConsumer({
    home: f.home, executor: 'dsh', activeInterval: 40, idleInterval: 40, heartbeatInterval: 100,
    create: () => { attempts++;if (attempts === 1) throw new Error('adapter not ready');return f.desktop; },
    onError: () => {},
  });
  t.after(() => worker.close());
  await worker.ready;
  await waitFor(() => f.sent.some(item => item.id === order.order_id), 2000, 'retry dispatch');
  assert.ok(attempts >= 2);
  assert.equal(f.sent.filter(item => item.id === order.order_id).length, 1);
  await worker.close();
});

test('the runner recovers when the initial processing pass fails after opening', async t => {
  const f = await environment(t);
  const order = await f.book.submit('work_submit', { goal: 'recover initial storage failure' });
  const request = OrderBook.prototype.request;
  let failed = false;
  OrderBook.prototype.request = function (id) {
    if (this.home === f.home && !failed) {
      failed = true;
      throw Object.assign(new Error('temporary storage failure'), { code: 'EIO' });
    }
    return request.call(this, id);
  };
  const worker = startConsumer({
    home: f.home, executor: 'dsh', activeInterval: 40, idleInterval: 40,
    heartbeatInterval: 100, create: () => f.desktop, onError: () => {},
  });
  try {
    await worker.ready;
    await waitFor(() => f.sent.some(item => item.id === order.order_id), 2000, 'initial pass retry');
    assert.equal(f.sent.filter(item => item.id === order.order_id).length, 1);
  } finally {
    await worker.close();
    OrderBook.prototype.request = request;
  }
});

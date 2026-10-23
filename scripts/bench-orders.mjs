#!/usr/bin/env node
// Synthetic, model-free comparison of the work-order hot path. Run the same
// script against the baseline checkout (read-only source) and this worktree,
// always with isolated temporary homes.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const here = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);
const fsp = require('node:fs/promises');
const native = {
  readFile: fsp.readFile, readdir: fsp.readdir, stat: fsp.stat, writeFile: fsp.writeFile,
  mkdir: fsp.mkdir, rm: fsp.rm, rename: fsp.rename, unlink: fsp.unlink,
};

function argumentsOf(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index++) {
    if (!argv[index].startsWith('--')) continue;
    const key = argv[index].slice(2);
    values[key] = argv[index + 1]?.startsWith('--') ? true : argv[++index];
  }
  return values;
}

function seedData(size, home) {
  return (async () => {
    const requests = join(home, 'requests');
    const states = join(home, 'states');
    await native.mkdir(requests, { recursive: true, mode: 0o700 });
    await native.mkdir(states, { recursive: true, mode: 0o700 });
    const base = Date.parse('2026-01-01T00:00:00Z');
    const writes = [];
    for (let index = 0; index < size; index++) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      const executor = index % 10 === 0 ? 'hermes' : 'dsh';
      const created = new Date(base + index * 1000).toISOString();
      const request = {
        id, kind: 'work_submit', fingerprint: `fingerprint-${index}`, created_at: created,
        payload: { executor, title: `finished-${index}`, goal: `completed task ${index} ${'g'.repeat(120)}` },
      };
      const state = {
        order_id: id, executor, status: 'completed', conversation_id: `finished-conversation-${index}`,
        updated_at: new Date(base + index * 1000 + 500).toISOString(), progress: 'done',
        events: [], output: { text: `result ${index} ${'o'.repeat(2000)}` },
      };
      writes.push(native.writeFile(join(requests, `${id}.json`), JSON.stringify(request)));
      writes.push(native.writeFile(join(states, `${id}.json`), JSON.stringify(state)));
    }
    const activeId = 'ffffffff-0000-4000-8000-000000000001';
    await native.writeFile(join(requests, `${activeId}.json`), JSON.stringify({
      id: activeId, kind: 'work_submit', fingerprint: 'active', created_at: new Date(base + size * 1000).toISOString(),
      payload: { executor: 'dsh', title: 'active task', goal: 'active task goal' },
    }));
    await native.writeFile(join(states, `${activeId}.json`), JSON.stringify({
      order_id: activeId, executor: 'dsh', status: 'executing', conversation_id: 'cw-active',
      updated_at: new Date(base + size * 1000 + 500).toISOString(), progress: 'running', events: [],
    }));
    await native.writeFile(join(home, 'settings.json'), JSON.stringify({
      hermes: { url: 'http://127.0.0.1:1', defaultDirectory: home },
    }));
    await Promise.all(writes);
    return { activeId, hermesTotal: Math.ceil(size / 10) };
  })();
}

function instrument(home) {
  const counters = { readFile: 0, readdir: 0, stat: 0, orderReads: 0, orderReaddirs: 0 };
  const orderRoots = [join(home, 'requests'), join(home, 'states')];
  const orderPath = path => {
    const value = String(path);
    return orderRoots.some(root => value === root || value.startsWith(root + '/'));
  };
  fsp.readFile = async (path, ...rest) => {
    counters.readFile++;
    if (orderPath(path)) counters.orderReads++;
    return native.readFile(path, ...rest);
  };
  fsp.readdir = async (path, ...rest) => {
    counters.readdir++;
    if (orderPath(path)) counters.orderReaddirs++;
    return native.readdir(path, ...rest);
  };
  fsp.stat = async (path, ...rest) => {
    counters.stat++;
    return native.stat(path, ...rest);
  };
  syncBuiltinESMExports();
  return {
    reset() { counters.readFile = 0; counters.readdir = 0; counters.stat = 0; counters.orderReads = 0; counters.orderReaddirs = 0; },
    snapshot() { return { ...counters }; },
  };
}

const cpuMs = (before) => {
  const value = process.cpuUsage(before);
  return Math.round((value.user + value.system) / 1000 * 100) / 100;
};
const rssMiB = () => Math.round(process.memoryUsage().rss / 1024 / 1024 * 10) / 10;
const maxRssMiB = () => Math.round(process.resourceUsage().maxRSS / 1024 * 10) / 10;
const ms = (start, end = process.hrtime.bigint()) => Math.round(Number(end - start) / 1e4) / 100;

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return Date.now();
    await delay(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function heartbeatWindow(book, windowMs) {
  const samples = [];
  const started = Date.now();
  while (Date.now() - started < windowMs) {
    const runtime = await book.runtime(null, 'dsh');
    samples.push({ now: Date.now(), at: Date.parse(runtime.snapshot?.at ?? '') || null });
    await delay(100);
  }
  const times = [...new Set(samples.map(sample => sample.at).filter(Number.isFinite))].sort((a, b) => a - b);
  let maxGap = 0;
  for (let index = 1; index < times.length; index++) maxGap = Math.max(maxGap, times[index] - times[index - 1]);
  const ages = samples.filter(sample => Number.isFinite(sample.at)).map(sample => Math.max(0, sample.now - sample.at));
  return {
    window_ms: Date.now() - started,
    samples: samples.length,
    beats: times.length,
    max_gap_ms: maxGap,
    max_age_ms: ages.length ? Math.max(...ages) : null,
  };
}

async function workerMode(options) {
  const source = resolve(options.src);
  const size = Number(options.size);
  const home = resolve(options.home);
  const label = options.label ?? source;
  const counters = instrument(home);
  const load = name => import(pathToFileURL(join(source, name)).href);
  const { activeId, hermesTotal } = await seedData(size, home);
  const { OrderBook, TERMINAL } = await load('orders.mjs');
  const { Consumer } = await load('worker.mjs');
  const { monitorSnapshot } = await load('monitor.mjs');
  const { lazyExecutor } = await load('executor-loader.mjs');
  let cacheModule;
  try { cacheModule = await load('order-cache.mjs'); } catch { cacheModule = null; }

  const stats = { sent: [], observeIds: 0, progress: 0, describe: 0 };
  const desktop = {
    async describe() { stats.describe++;return { models: [] }; },
    observe(ids) {
      const unique = [...new Set(ids)];
      stats.observeIds = Math.max(stats.observeIds, unique.length);
      return unique.map(id => ({ id, status: 'idle' }));
    },
    async start(order) { return { conversation_id: `cw-${order.id}`, checkpoint: 0 }; },
    async send(order) { stats.sent.push({ id: order.id, at: Date.now() }); },
    async checkpoint(id) { return { conversation_id: id, checkpoint: 1 }; },
    async progress() { stats.progress++;return { status: 'executing', progress: 'waiting' }; },
    async cancel() {},
    close() {},
  };

  const book = new OrderBook(home);
  const consumer = new Consumer(home, desktop, { executor: 'dsh', fallbackInterval: 2500 });

  counters.reset();
  const coldCpu = process.cpuUsage();
  const coldStart = process.hrtime.bigint();
  await consumer.open();
  await consumer.tick();
  const coldReads = counters.snapshot();
  const cold = {
    ms: ms(coldStart), cpu_ms: cpuMs(coldCpu), rss_mib: rssMiB(),
    ...coldReads,
  };

  const warmTicks = 20;
  counters.reset();
  const warmCpu = process.cpuUsage();
  const warmStart = process.hrtime.bigint();
  for (let index = 0; index < warmTicks; index++) await consumer.tick();
  const warmReads = counters.snapshot();
  const warm = {
    ticks: warmTicks, ms: ms(warmStart), cpu_ms: cpuMs(warmCpu),
    rss_after_mib: rssMiB(), max_rss_mib: maxRssMiB(),
    observe_ids_max: stats.observeIds, progress_calls: stats.progress,
    ...warmReads,
    order_reads_per_tick: Math.round(warmReads.orderReads / warmTicks * 100) / 100,
  };

  // Start the real scheduling contract: optimized builds have Consumer.start,
  // the baseline keeps its historical fixed 750 ms interval.
  const baselineInterval = typeof consumer.start === 'function' ? null : setInterval(() => { void consumer.tick(); }, 750);
  if (typeof consumer.start === 'function') consumer.start({ activeInterval: 750, idleInterval: 2500, heartbeatInterval: 2000 });
  await delay(50);

  const sameId = randomUUID();
  const sameStarted = Date.now();
  await new OrderBook(home).submit('work_submit', { order_id: sameId, goal: 'same-process discovery' });
  await waitFor(() => stats.sent.some(item => item.id === sameId), 5000, 'same-process dispatch');
  const sameProcessMs = Date.now() - sameStarted;

  const crossId = randomUUID();
  const childScript = `import(${JSON.stringify(pathToFileURL(join(source, 'orders.mjs')).href)}).then(async ({ OrderBook }) => { const book = new OrderBook(${JSON.stringify(home)}); await book.submit('work_submit', { order_id: ${JSON.stringify(crossId)}, goal: 'cross-process discovery' }); });`;
  const crossStarted = Date.now();
  const child = spawn(process.execPath, ['-e', childScript], { stdio: 'ignore' });
  const childClosed = new Promise(resolveChild => child.once('close', resolveChild));
  await waitFor(() => stats.sent.some(item => item.id === crossId), 5000, 'cross-process dispatch');
  const crossProcessMs = Date.now() - crossStarted;
  await childClosed;

  const sentCounts = stats.sent.reduce((counts, item) => counts.set(item.id, (counts.get(item.id) ?? 0) + 1), new Map());
  const duplicateSends = [...sentCounts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);

  // Complete every pending order and sample a full idle window.
  for (const order of await book.list()) {
    if (!TERMINAL.has(order.status)) await book.transition(order.order_id, 'completed');
  }
  await delay(400);
  const idleHeartbeat = await heartbeatWindow(book, 8000);

  // One deliberately slow catalog probe: the independent heartbeat should keep
  // publishing while the processing loop is blocked.
  let slowOnce = true;
  desktop.describe = async () => {
    stats.describe++;
    if (slowOnce) { slowOnce = false;await delay(7000); }
    return { models: [] };
  };
  if (typeof consumer.nextCatalog === 'number') consumer.nextCatalog = 0;
  const slowId = randomUUID();
  await new OrderBook(home).submit('work_submit', { order_id: slowId, goal: 'blocked processing window' });
  const slowHeartbeat = await heartbeatWindow(book, 8000);
  for (const order of await book.list()) {
    if (!TERMINAL.has(order.status)) await book.transition(order.order_id, 'completed');
  }

  if (baselineInterval) clearInterval(baselineInterval);
  await consumer.close();

  // Loader checks: completed Hermes history must not load a worker, and the
  // warm check should not reparse it.
  const loader = lazyExecutor(home, {
    executor: 'hermes', settingsKey: 'hermes', interval: 60000,
    load: async () => ({ startExecutorWorker: () => ({ async close() {} }) }),
  });
  await loader.check();
  counters.reset();
  const loaderStart = process.hrtime.bigint();
  await loader.check();
  const loaderReads = counters.snapshot();
  const loaderResult = { ms: ms(loaderStart), loaded: loader.state.loaded, hermes_completed: hermesTotal, ...loaderReads };
  await loader.close();

  // Board refresh: cold one-shot, then warm shared-index reads when supported.
  counters.reset();
  const monitorColdStart = process.hrtime.bigint();
  await monitorSnapshot(home, { limit: 30 });
  const monitorCold = { ms: ms(monitorColdStart), ...counters.snapshot() };
  let monitorWarm;
  let sharedIndex = null;
  if (cacheModule?.acquireOrderIndex) {
    sharedIndex = await cacheModule.acquireOrderIndex(home);
    counters.reset();
    const started = process.hrtime.bigint();
    for (let index = 0; index < 5; index++) await monitorSnapshot(home, { limit: 30, index: sharedIndex });
    monitorWarm = { rounds: 5, ms: ms(started), shared_index: true, ...counters.snapshot() };
    await cacheModule.releaseOrderIndex(sharedIndex);
  } else {
    counters.reset();
    const started = process.hrtime.bigint();
    for (let index = 0; index < 5; index++) await monitorSnapshot(home, { limit: 30 });
    monitorWarm = { rounds: 5, ms: ms(started), shared_index: false, ...counters.snapshot() };
  }

  const result = {
    label, source, size, node: process.version,
    cold, warm,
    latency: { same_process_ms: sameProcessMs, cross_process_ms: crossProcessMs, duplicate_sends: duplicateSends },
    idle_heartbeat: idleHeartbeat,
    slow_processing_heartbeat: slowHeartbeat,
    loader: loaderResult,
    monitor: { cold: monitorCold, warm: monitorWarm },
    max_rss_mib: maxRssMiB(),
  };
  process.stdout.write(`BENCH_JSON ${JSON.stringify(result)}\n`);
  await rm(home, { recursive: true, force: true });
}

function gitInfo(directory) {
  try {
    const revision = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['-C', directory, 'status', '--porcelain'], { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    return { revision, dirty_files: dirty.length, dirty };
  } catch (error) {
    return { error: error.message };
  }
}

async function parentMode(options) {
  const sizes = String(options.sizes ?? '100,1000').split(',').map(Number);
  if (typeof options.baseline !== 'string') {
    throw new Error('Pass --baseline /path/to/baseline-checkout; every benchmark uses isolated temporary data.');
  }
  const baseline = resolve(options.baseline);
  const outDir = resolve(options.out ?? join(fileURLToPath(new URL('../.local/', import.meta.url)), 'perf'));
  await native.mkdir(outDir, { recursive: true });
  const sources = [
    { label: 'baseline', src: join(baseline, 'src') },
    { label: 'current', src: join(fileURLToPath(new URL('../src/', import.meta.url))) },
  ];
  const baselineInfo = gitInfo(baseline);
  const worktreeInfo = gitInfo(fileURLToPath(new URL('..', import.meta.url)));
  console.log(`baseline ${baselineInfo.revision ?? baselineInfo.error} (${baselineInfo.dirty_files ?? '?'} dirty entries)`);
  const results = [];
  for (const [round, size] of sizes.entries()) {
    // Alternate who runs first so page-cache/order drift is not always in the
    // same direction across sizes.
    const order = round % 2 === 0 ? sources : [...sources].reverse();
    for (const source of order) {
      const home = await mkdtemp(join(tmpdir(), `cta-bench-${source.label}-${size}-`));
      const started = Date.now();
      const child = spawn(process.execPath, [here, '--worker', '--src', source.src, '--size', String(size), '--home', home, '--label', source.label], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let output = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { output += chunk; });
      const code = await new Promise(resolveChild => child.once('close', resolveChild));
      if (code !== 0) throw new Error(`${source.label}/${size} benchmark failed with code ${code}`);
      const line = output.split('\n').find(value => value.startsWith('BENCH_JSON '));
      if (!line) throw new Error(`${source.label}/${size} benchmark produced no result`);
      const result = JSON.parse(line.slice('BENCH_JSON '.length));
      result.elapsed_ms = Date.now() - started;
      result.run_order = round % 2 === 0 ? (source.label === 'baseline' ? 1 : 2) : (source.label === 'current' ? 1 : 2);
      results.push(result);
      await rm(home, { recursive: true, force: true }).catch(() => {});
    }
  }
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\..+$/, '');
  const path = join(outDir, `bench-${stamp}.json`);
  await native.writeFile(path, JSON.stringify({
    generated_at: new Date().toISOString(), node: process.version,
    baseline: { path: baseline, ...baselineInfo }, worktree: worktreeInfo, results,
  }, null, 2));
  console.log(`wrote ${path}`);
  for (const result of results) {
    console.log(`\n${result.label} · ${result.size} completed orders (run order ${result.run_order})`);
    console.log(`  cold open+tick: ${result.cold.ms} ms, ${result.cold.orderReads} order reads, ${result.cold.cpu_ms} ms cpu, ${result.cold.rss_mib} MiB rss`);
    console.log(`  warm ${result.warm.ticks} ticks: ${result.warm.orderReads} order reads (${result.warm.order_reads_per_tick}/tick), ${result.warm.orderReaddirs} order readdirs, ${result.warm.stat} stat, ${result.warm.ms} ms, ${result.warm.cpu_ms} ms cpu`);
    console.log(`  observe ids max ${result.warm.observe_ids_max}, progress-eligible calls ${result.warm.progress_calls}`);
    console.log(`  wake latency same/cross process: ${result.latency.same_process_ms} / ${result.latency.cross_process_ms} ms, duplicate sends ${result.latency.duplicate_sends}`);
    console.log(`  heartbeat idle max gap ${result.idle_heartbeat.max_gap_ms} ms / max age ${result.idle_heartbeat.max_age_ms} ms; slow probe gap ${result.slow_processing_heartbeat.max_gap_ms} ms`);
    console.log(`  loader warm check ${result.loader.orderReads} order reads, loaded=${result.loader.loaded}`);
    console.log(`  monitor cold ${result.monitor.cold.orderReads} order reads; warm ${result.monitor.warm.orderReads} order reads × ${result.monitor.warm.rounds} (shared=${result.monitor.warm.shared_index})`);
  }
}

const options = argumentsOf(process.argv.slice(2));
if (options.worker) await workerMode(options);
else await parentMode(options);

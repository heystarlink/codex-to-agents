import { OrderBook } from './orders.mjs';
import { EXECUTORS } from './executors.mjs';
import { readDelegation } from './delegation.mjs';
import { usageStatus } from './usage.mjs';

const epoch = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

// The board and the HTTP settings page only need delegation, usage consent and
// executor connection metadata. They must not touch work-order files: a large
// or damaged history cannot slow down or break the settings surface, and no
// order body, title, progress or output ever reaches it. The terminal monitor
// keeps using monitorSnapshot for the full read-only view.
export async function readExecutorRuntimes(home, now = Date.now()) {
  const book = new OrderBook(home);
  const warnings = [];
  let delegation;
  try { delegation = await readDelegation(home); }
  catch {
    delegation = { enabled: false, executor: 'hermes', error: '自动派工设置读取失败，请重新保存开关。' };
    warnings.push(delegation.error);
  }
  const executors = {};
  for (const name of EXECUTORS) {
    let runtime = { online: false, snapshot: null };
    try { runtime = await book.runtime(null, name); }
    catch (error) { warnings.push(`${name} 运行快照读取失败：${error.message}`); }
    runtime.online = Boolean(runtime.snapshot?.active && now - (epoch(runtime.snapshot.at) ?? 0) < 6000);
    executors[name] = runtime;
  }
  return { delegation, executors, warnings };
}

export function workerSnapshot(executors, now = Date.now()) {
  const online = Object.values(executors).some(runtime => runtime.online);
  const latest = Object.values(executors).map(runtime => runtime.snapshot).filter(Boolean)
    .sort((a, b) => (epoch(b.at) ?? 0) - (epoch(a.at) ?? 0))[0];
  return {
    online, last_seen: latest?.at ?? null,
    heartbeat_age_ms: latest ? Math.max(0, now - (epoch(latest.at) ?? 0)) : null,
    pid: latest?.pid ?? null, live_sessions_available: Object.values(executors).some(runtime => Array.isArray(runtime.snapshot?.sessions)),
    catalog_error: Object.values(executors).find(runtime => runtime.snapshot?.catalog?.error)?.snapshot.catalog.error ?? null,
    executors: Object.fromEntries(Object.entries(executors).map(([name, runtime]) => [name, {
      online: runtime.online, last_seen: runtime.snapshot?.at ?? null,
      models: runtime.snapshot?.catalog?.models ?? [],
      // Older consumers omit this heartbeat field entirely. Keeping the raw
      // value lets the board distinguish "not supported" from "supported but
      // no preset available" instead of assuming the control exists.
      permission_control: runtime.snapshot?.catalog?.permission_control ?? null,
      catalog_error: runtime.snapshot?.catalog?.error ?? null,
    }])),
  };
}

export function settingsView({ delegation, executors, now = Date.now() }) {
  return {
    generated_at: new Date(now).toISOString(), delegation,
    service: { pid: process.pid, name: process.title, rss_mib: Math.round(process.memoryUsage.rss() / 1024 / 1024) },
    worker: workerSnapshot(executors, now),
  };
}

export async function settingsSnapshot(home, { now = Date.now() } = {}) {
  const { delegation, executors, warnings } = await readExecutorRuntimes(home, now);
  return { ...settingsView({ delegation, executors, now }), usage: await usageStatus(home), warnings };
}

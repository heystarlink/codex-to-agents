import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { OrderBook } from './orders.mjs';
import { readDelegation } from './delegation.mjs';
import { usageStatus } from './usage.mjs';

export const ACTIVE = new Set(['queued', 'dispatching', 'executing']);
export const PROBLEMS = new Set(['failed', 'blocked', 'uncertain']);
export const LABELS = {
  queued: '等待领取', dispatching: '正在派发', executing: '执行中', completed: '已完成',
  failed: '失败', blocked: '已阻塞', uncertain: '待核查', cancelled: '已取消',
  running: '运行中', idle: '空闲', unloaded: '未加载', unknown: '未知',
};

const epoch = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const clean = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
const actionName = { work_submit: '执行任务', work_update: '更新任务', workspace_control: '项目操作', conversation_control: '会话操作' };

export function elapsed(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

// This projection is read-only. Opening a monitor never creates the data folder,
// publishes work, wakes an execution agent, or changes a task's state.
export async function monitorSnapshot(home, { limit = 30, now = Date.now() } = {}) {
  const book = new OrderBook(home);
  const warnings = [];
  let delegation;
  try { delegation = await readDelegation(home); }
  catch { delegation = { enabled: false, executor: 'hermes', error: '自动派工设置读取失败，请重新保存开关。' };warnings.push(delegation.error); }
  const executors = {};
  for (const name of ['dsh', 'hermes']) {
    let runtime = { online: false, snapshot: null };
    try { runtime = await book.runtime(null, name); }
    catch (error) { warnings.push(`${name} 运行快照读取失败：${error.message}`); }
    runtime.online = Boolean(runtime.snapshot?.active && now - (epoch(runtime.snapshot.at) ?? 0) < 6000);
    executors[name] = runtime;
  }
  const online = Object.values(executors).some(runtime => runtime.online);
  const latest = Object.values(executors).map(runtime => runtime.snapshot).filter(Boolean)
    .sort((a, b) => (epoch(b.at) ?? 0) - (epoch(a.at) ?? 0))[0];
  let files = [];
  try { files = await readdir(book.requests); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const ids = files.filter(file => /^[0-9a-f-]{36}\.json$/.test(file)).map(file => file.slice(0, -5));
  const reads = await Promise.allSettled(ids.map(async id => {
    const [state, request] = await Promise.all([book.inspect(id), book.request(id)]);
    const input = request.payload;
    const start = epoch(state.created_at) ?? now;
    const end = ACTIVE.has(state.status) ? now : epoch(state.updated_at) ?? start;
    return {
      ...state, title: input.title ?? (clean(input.goal).trim().slice(0, 100) || `${actionName[state.kind] ?? state.kind} · ${input.action ?? ''}`),
      goal: input.goal ?? input.message ?? '', action: input.action ?? null,
      model: state.route?.model ?? input.model ?? null, provider: state.route?.provider ?? input.provider ?? null,
      directory: state.directory ?? input.directory ?? null,
      elapsed_ms: Math.max(0, end - start),
      stale: !executors[state.executor].online && ACTIVE.has(state.status),
    };
  }));
  const orders = [];
  reads.forEach((result, index) => {
    if (result.status === 'fulfilled') orders.push(result.value);
    else warnings.push(`工作单 ${ids[index].slice(0, 8)} 读取失败：${result.reason.message}`);
  });
  orders.sort((a, b) => b.created_at.localeCompare(a.created_at) || a.order_id.localeCompare(b.order_id));
  const summary = { total: orders.length, active: 0, completed: 0, problems: 0, cancelled: 0 };
  for (const order of orders) {
    if (ACTIVE.has(order.status)) summary.active++;
    else if (order.status === 'completed') summary.completed++;
    else if (PROBLEMS.has(order.status)) summary.problems++;
    else if (order.status === 'cancelled') summary.cancelled++;
  }
  const live = new Map(Object.entries(executors).flatMap(([name, runtime]) =>
    (runtime.snapshot?.sessions ?? []).map(session => [`${name}:${session.id}`, session.status])));
  const grouped = new Map();
  for (const order of orders) {
    if (!order.conversation_id) continue;
    const key = `${order.executor}:${order.conversation_id}`;
    const connected = executors[order.executor].online;
    let agent = grouped.get(key);
    if (!agent) {
      agent = { id: order.conversation_id, executor: order.executor, model: null, provider: null, order_count: 0,
        status: connected ? live.get(key) ?? 'unknown' : 'unknown',
        stale: !connected, latest_order: order.order_id, latest_title: order.title, latest_task_status: order.status };
      grouped.set(key, agent);
    }
    agent.order_count++;
    agent.model ??= order.model;agent.provider ??= order.provider;
  }
  return {
    generated_at: new Date(now).toISOString(), home, delegation, usage: await usageStatus(home),
    service: { pid: process.pid, name: process.title, rss_mib: Math.round(process.memoryUsage.rss() / 1024 / 1024) },
    worker: { online, last_seen: latest?.at ?? null,
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
      }])) },
    summary, agents: [...grouped.values()], orders: orders.slice(0, limit), warnings,
  };
}

function charWidth(char) {
  if (/\p{Mark}/u.test(char)) return 0;
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Extended_Pictographic}]/u.test(char) ? 2 : 1;
}

export function fit(value, width) {
  const text = clean(value);
  if (width < 1) return '';
  const full = [...text].reduce((total, char) => total + charWidth(char), 0);
  if (full <= width) return text + ' '.repeat(width - full);
  let output = '';let used = 0;
  for (const char of text) {
    const next = charWidth(char);
    if (used + next > width - 1) break;
    output += char;used += next;
  }
  return output + '…' + ' '.repeat(width - used - 1);
}

export function filterOrders(orders, filter) {
  return filter === 'active' ? orders.filter(item => ACTIVE.has(item.status))
    : filter === 'problems' ? orders.filter(item => PROBLEMS.has(item.status)) : orders;
}

export function renderTerminal(snapshot, { width = 110, height = 35, selected = 0, filter = 'all' } = {}) {
  width = Math.max(45, Math.min(200, width));
  const rows = [];
  const add = text => rows.push(fit(text, width).trimEnd());
  add(`codex-to-agents  |  ${snapshot.worker.online ? '消费者在线' : '消费者离线'}  |  只读监控`);
  add(`任务 ${snapshot.summary.total}   进行中 ${snapshot.summary.active}   已完成 ${snapshot.summary.completed}   待处理 ${snapshot.summary.problems}`);
  add('');add(`Agent 执行会话 (${snapshot.agents.length})`);
  if (!snapshot.agents.length) add('暂无执行会话。派发任务后会自动显示。');
  for (const agent of snapshot.agents.slice(0, 4)) {
    add(`  ${agent.executor} · ${agent.id.slice(0, 15)}  ${agent.model ?? '—'}  ${LABELS[agent.status] ?? agent.status}${agent.stale ? '（离线，状态未知）' : ''}`);
  }
  if (snapshot.agents.length > 4) add(`  另有 ${snapshot.agents.length - 4} 个会话，可用 monitor --json 查询。`);
  if (snapshot.worker.online && !snapshot.worker.live_sessions_available && snapshot.agents.length) add('当前消费者尚未提供实时会话快照；重载 DSH 插件后可查看。');
  add('');add(`工作单  [${{ all: '全部', active: '进行中', problems: '待处理' }[filter]}]`);
  const orders = filterOrders(snapshot.orders, filter);
  const capacity = Math.max(1, height - rows.length - 10);
  const index = Math.max(0, Math.min(selected, orders.length - 1));
  const start = Math.max(0, index - capacity + 1);
  if (!orders.length) add('暂无匹配任务。');
  for (const [offset, order] of orders.slice(start, start + capacity).entries()) {
    const marker = offset + start === index ? '>' : ' ';
    const titleWidth = Math.max(10, width - 47);
    add(`${marker} ${order.order_id.slice(0, 8)}  ${fit(LABELS[order.status] ?? order.status, 10)} ${fit(order.title, titleWidth)} ${fit(order.model ?? '—', 17)} ${elapsed(order.elapsed_ms)}${order.stale ? ' *' : ''}`);
  }
  const current = orders[index];
  if (current) {
    add('');add(`任务：${current.title}`);
    add(`模型：${current.model ?? '—'}  会话：${current.conversation_id ?? '等待创建'}`);
    add(`最新：${current.error || current.output?.text || current.progress || current.goal || '暂无结果'}`);
    add(`更新：${current.updated_at ?? current.created_at}${current.stale ? '  * 状态已过期' : ''}`);
  }
  if (snapshot.warnings.length) add(`读取提示：${snapshot.warnings[0]}`);
  add('');add('↑↓ / j k 选择   f 切换筛选   r 刷新   q 退出');
  return rows.slice(0, Math.max(12, height)).join('\n');
}

export async function monitorTerminal(home, { once = false, json = false, interval = 1000, limit = 30,
  input = process.stdin, output = process.stdout } = {}) {
  if (once || json || !input.isTTY || !output.isTTY) {
    const snapshot = await monitorSnapshot(home, { limit });
    output.write((json ? JSON.stringify(snapshot, null, 2) : renderTerminal(snapshot, { width: output.columns ?? 110, height: 100 })) + '\n');
    return;
  }
  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  input.setRawMode(true);input.resume();
  output.write('\x1b[?1049h\x1b[?25l');
  await new Promise(resolve => {
    let stopped = false;let busy = false;let selected = 0;let filter = 'all';let snapshot;
    const redraw = () => {
      if (snapshot && !stopped) output.write('\x1b[H\x1b[2J' + renderTerminal(snapshot, {
        width: output.columns ?? 110, height: output.rows ?? 35, selected, filter,
      }));
    };
    const refresh = async () => {
      if (stopped || busy) return;
      busy = true;
      try { snapshot = await monitorSnapshot(home, { limit });redraw(); }
      catch (error) { if (!stopped) output.write('\x1b[H\x1b[2J读取失败：' + clean(error.message)); }
      finally { busy = false; }
    };
    const stop = () => {
      if (stopped) return;stopped = true;
      clearInterval(timer);input.off('keypress', keypress);output.off('resize', redraw);
      process.off('SIGINT', stop);process.off('SIGTERM', stop);
      input.setRawMode(Boolean(wasRaw));input.pause();
      output.write('\x1b[?25h\x1b[?1049l');resolve();
    };
    const keypress = (_text, key = {}) => {
      if (key.name === 'q' || key.ctrl && key.name === 'c') return stop();
      const size = filterOrders(snapshot?.orders ?? [], filter).length;
      if (['down', 'j'].includes(key.name)) selected = Math.min(Math.max(0, size - 1), selected + 1);
      if (['up', 'k'].includes(key.name)) selected = Math.max(0, selected - 1);
      if (key.name === 'f') { filter = { all: 'active', active: 'problems', problems: 'all' }[filter];selected = 0; }
      if (key.name === 'r') void refresh();
      redraw();
    };
    const timer = setInterval(() => { void refresh(); }, interval);
    input.on('keypress', keypress);output.on('resize', redraw);
    process.once('SIGINT', stop);process.once('SIGTERM', stop);
    void refresh();
  });
}

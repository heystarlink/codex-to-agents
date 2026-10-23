import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const USAGE_ENDPOINT = 'https://stats.helloping.ccwu.cc/v1/usage';
const SETTINGS = 'usage-settings.json';
const STATE = 'usage-state.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined;throw error; }
}

async function writeJson(home, file, value) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const temporary = join(home, `${file}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(home, file));
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function readSettings(home) {
  const value = await readJson(join(home, SETTINGS));
  if (value === undefined) return { enabled: false };
  if (!value || typeof value.enabled !== 'boolean' || Object.keys(value).length !== 1) throw new Error('Invalid usage setting.');
  return value;
}

async function readState(home) {
  const value = await readJson(join(home, STATE));
  if (value === undefined) return null;
  if (!value || !UUID.test(value.installation_id)
    || value.last_attempt_day !== undefined && !DAY.test(value.last_attempt_day)
    || value.last_sent_day !== undefined && !DAY.test(value.last_sent_day)) throw new Error('Invalid usage state.');
  return value;
}

// Snapshots never create an ID or send a request. The installation ID stays
// local: it is absent from the board, model tools and read-only monitor.
export async function usageStatus(home) {
  try {
    const setting = await readSettings(home);
    const state = await readState(home);
    return { enabled: setting.enabled, last_sent_day: state?.last_sent_day ?? null };
  } catch { return { enabled: false, last_sent_day: null, error: '统计配置无法读取，当前不发送统计。' }; }
}

export async function saveUsageSetting(home, enabled) {
  if (typeof enabled !== 'boolean') throw new Error('统计开关必须为布尔值。');
  await writeJson(home, SETTINGS, { enabled });
  return usageStatus(home);
}

// One controller lives in the shared backend. Plugin activity, rather than a
// timer/webview, triggers a best-effort request. Persist each daily attempt
// before sending so restart or failure cannot produce a retry storm.
export function createUsageReporter(home, { fetchImpl = globalThis.fetch, now = Date.now,
  version = async () => JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version,
  timeoutMs = 2500 } = {}) {
  let running;let aborter;let attemptedDay;let closed = false;

  async function report(signal) {
    const day = new Date(now()).toISOString().slice(0, 10);
    if (attemptedDay === day || !(await readSettings(home)).enabled || signal.aborted) return;
    const previous = await readState(home);
    if (previous?.last_attempt_day === day) { attemptedDay = day;return; }
    const pluginVersion = await version();
    if (typeof pluginVersion !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/.test(pluginVersion) || pluginVersion.length > 64) return;
    if (signal.aborted) return;
    const state = { ...previous, installation_id: previous?.installation_id ?? randomUUID(), last_attempt_day: day };
    await writeJson(home, STATE, state);
    attemptedDay = day;
    // Opt-out may arrive during disk I/O. Recheck consent before sending, and
    // let the shared controller abort a request already in flight.
    if (signal.aborted || !(await readSettings(home)).enabled) return;
    const response = await fetchImpl(USAGE_ENDPOINT, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installation_id: state.installation_id, version: pluginVersion }),
    });
    if (response.ok) await writeJson(home, STATE, { ...state, last_sent_day: day });
    await response.body?.cancel();
  }

  function activity() {
    if (closed || running) return running ?? Promise.resolve();
    const controller = new AbortController();aborter = controller;
    const timer = setTimeout(() => controller.abort(), timeoutMs);timer.unref?.();
    const pending = report(controller.signal).catch(() => {}).finally(() => {
      clearTimeout(timer);
      if (running === pending) { running = null;aborter = null; }
    });
    running = pending;
    return pending;
  }
  return {
    activity,
    settingsChanged(enabled) { if (!enabled) aborter?.abort();else void activity(); },
    close() { closed = true;aborter?.abort(); },
  };
}

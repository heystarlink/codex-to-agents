import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoUpdateSetting, runBoardUpdate, checkDailyUpdate, UPDATE_REMINDER_INTERVAL as DAY } from '../src/update-reminder.mjs';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'agents-update-reminder-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls = [];
  let state = { status: 'idle' };
  return { home, calls, setState(value) { state = value; },
    async update(root, { action }) {
      assert.equal(root, home);calls.push(action);
      return action === 'check' ? { status: 'checking' } : state;
    },
  };
}

test('automatic checks share a rolling 24-hour claim across boards, including midnight', async t => {
  const { home, update, calls } = await fixture(t);
  const start = Date.parse('2026-10-22T23:55:00Z');
  assert.equal((await checkDailyUpdate(home, update, { now: start })).status, 'checking');
  await checkDailyUpdate(home, update, { now: start + 10 * 60 * 1000 });
  await checkDailyUpdate(home, update, { now: start + DAY - 1 });
  assert.equal(calls.filter(action => action === 'check').length, 1);
  await checkDailyUpdate(home, update, { now: start + DAY });
  assert.equal(calls.filter(action => action === 'check').length, 2);
  await checkDailyUpdate(home, update, { now: start + 4 * DAY });
  assert.equal(calls.filter(action => action === 'check').length, 3);
  assert.equal((await readdir(join(home, 'update-reminders'))).length, 1, 'old claims are pruned');
  const day = Math.floor((start + 4 * DAY) / DAY);
  assert.equal(Number(await readFile(join(home, 'update-reminders', String(day)), 'utf8')), start + 4 * DAY);
});

test('simultaneous board connections start at most one automatic check', async t => {
  const { home, update, calls } = await fixture(t);
  const now = Date.parse('2026-10-23T12:00:00Z');
  await Promise.all(Array.from({ length: 30 }, () => checkDailyUpdate(home, update, { now })));
  assert.equal(calls.filter(action => action === 'check').length, 1);
  assert.ok(calls.every(action => ['status', 'check'].includes(action)), 'automatic reminder never applies');
});

test('manual recent checks and active or unfinished installs retain their cached state', async t => {
  const { home, update, calls, setState } = await fixture(t);
  const now = Date.parse('2026-10-23T12:00:00Z');
  for (const state of [
    { status: 'available', checked_at: new Date(now - 1000).toISOString() },
    { status: 'checking' }, { status: 'updating' },
    { status: 'failed', pending_install: true },
    { status: 'updated', restart_required: true, updated_at: new Date(now - 1000).toISOString() },
  ]) {
    setState(state);
    assert.deepEqual(await checkDailyUpdate(home, update, { now }), state);
  }
  assert.ok(calls.every(action => action === 'status'));
  setState({ status: 'updated', restart_required: true, updated_at: new Date(now - DAY).toISOString() });
  await checkDailyUpdate(home, update, { now });
  assert.equal(calls.at(-1), 'check', 'a cached restart flag cannot suppress checks forever');
});

test('offline/start failures consume the daily attempt without blocking explicit manual retry', async t => {
  const { home, calls, update } = await fixture(t);
  const now = Date.parse('2026-10-23T12:00:00Z');
  const offline = async (root, input) => {
    const value = await update(root, input);
    if (input.action === 'check') throw new Error('offline');
    return value;
  };
  await assert.rejects(checkDailyUpdate(home, offline, { now }), /offline/);
  await checkDailyUpdate(home, offline, { now: now + 1000 });
  assert.equal(calls.filter(action => action === 'check').length, 1);
  await update(home, { action: 'check' });
  assert.equal(calls.filter(action => action === 'check').length, 2, 'manual check does not use the daily gate');
});

test('auto updates default OFF without creating data, persist independently, and fail closed on corrupt settings', async t => {
  const { home, update, setState, calls } = await fixture(t);
  assert.deepEqual(await readdir(home), []);
  assert.deepEqual(await autoUpdateSetting(home), { auto_update: false });
  assert.deepEqual(await readdir(home), []);
  setState({ status: 'available', checked_at: new Date().toISOString() });
  assert.equal((await runBoardUpdate(home, { action: 'check_daily' }, update)).status, 'available');
  assert.ok(!calls.includes('apply'));
  assert.equal((await runBoardUpdate(home, { action: 'set_auto', enabled: true }, update)).auto_update, true);
  assert.ok(!calls.includes('apply'), 'saving consent alone only reads status');
  assert.deepEqual(await autoUpdateSetting(home), { auto_update: true });
  assert.deepEqual(await readdir(home), ['auto-update-settings.json']);
  await access(join(home, 'auto-update-settings.json'));
  await writeFile(join(home, 'auto-update-settings.json'), '{broken');
  const value = await runBoardUpdate(home, { action: 'check_daily' }, update);
  assert.equal(value.auto_update, false);assert.match(value.auto_update_error, /无法读取/);
  assert.ok(!calls.includes('apply'));
  assert.equal((await runBoardUpdate(home, { action: 'set_auto', enabled: false }, update)).auto_update, false);
});

test('only enabled automatic actions apply an available update; status and unfinished installs never apply', async t => {
  const { home, update, setState, calls } = await fixture(t);
  await runBoardUpdate(home, { action: 'set_auto', enabled: true }, update);
  for (const state of [{ status: 'idle' }, { status: 'checking' }, { status: 'updating' },
    { status: 'failed' }, { status: 'blocked' }, { status: 'updated' },
    { status: 'available', pending_install: true }]) {
    setState(state);await runBoardUpdate(home, { action: 'check_daily' }, update);
  }
  setState({ status: 'available', checked_at: new Date().toISOString() });
  await runBoardUpdate(home, { action: 'status' }, update);
  assert.ok(!calls.includes('apply'));
  await runBoardUpdate(home, { action: 'check_daily' }, update);
  await runBoardUpdate(home, { action: 'check_daily' }, update);
  assert.equal(calls.filter(action => action === 'apply').length, 2);
  await runBoardUpdate(home, { action: 'set_auto', enabled: false }, update);
  await runBoardUpdate(home, { action: 'check_daily' }, update);
  assert.equal(calls.filter(action => action === 'apply').length, 2);
});

test('turning OFF in another board during a status read prevents the pending auto install', async t => {
  const { home, update, setState, calls } = await fixture(t);
  await runBoardUpdate(home, { action: 'set_auto', enabled: true }, update);
  setState({ status: 'available', checked_at: new Date().toISOString() });
  let release;let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const slow = async (root, input) => {
    if (input.action === 'status') { entered();await new Promise(resolve => { release = resolve; }); }
    return update(root, input);
  };
  const pending = runBoardUpdate(home, { action: 'check_daily' }, slow);
  await started;
  await runBoardUpdate(home, { action: 'set_auto', enabled: false }, update);
  release();
  assert.equal((await pending).auto_update, false);
  assert.ok(!calls.includes('apply'));
});

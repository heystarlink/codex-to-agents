import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const settle = () => new Promise(resolve => setImmediate(resolve));
async function panelFixture(call, { dailyUpdate = async () => ({ status: 'idle' }), hidden = false } = {}) {
  const timers = new Map();const elements = new Map();const documentEvents = new Map();let nextTimer = 0;
  const element = () => ({ checked: false, disabled: false, value: '', textContent: '', className: '', children: [], replacements: 0,
    hidden: false, open: false,
    classList: { toggle() {}, remove() {} },
    replaceChildren(...children) { this.children = children;this.replacements++; },
    addEventListener(name, callback) { this[name] = callback; },
  });
  const document = { hidden, documentElement: {},
    addEventListener(name, callback) { documentEvents.set(name, callback); },
    createElement: element,
    getElementById(id) { if (!elements.has(id)) elements.set(id, element());return elements.get(id); },
  };
  const source = await readFile(new URL('../src/monitor-client.js', import.meta.url), 'utf8');
  const hostCall = (name, input) => name === 'panel_update' && input.action === 'check_daily'
    ? dailyUpdate(name, input) : call(name, input);
  vm.runInNewContext(source, { document, window: { addEventListener() {}, agentsHost: { onClose() {}, call: hostCall } },
    setTimeout(callback) { const id = nextTimer++;timers.set(id, callback);return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  await settle();
  return {
    $: id => elements.get(id), document, documentEvents, timers,
    async poll() { const [id, fn] = timers.entries().next().value;timers.delete(id);fn();await settle(); },
    async runTimers() { const pending = [...timers.values()];timers.clear();for (const fn of pending) fn();await settle(); },
  };
}

test('usage switch defaults OFF, saves independently, rejects stale snapshots and restores failed saves', async () => {
  let usage = { enabled: false, last_sent_day: null };let rejectSave = false;let delayNext = false;let delayed;
  const calls = [];
  const { $, poll } = await panelFixture(async (name, input) => {
    if (name === 'panel_usage') {
      calls.push(JSON.parse(JSON.stringify(input)));
      if (rejectSave) throw new Error('network');
      usage = { ...usage, enabled: input.enabled };return usage;
    }
    assert.equal(name, 'panel_snapshot');
    const view = { usage: { ...usage }, delegation: { enabled: false, executor: 'dsh' }, worker: { executors: { dsh: { models: [] } } } };
    if (delayNext) { delayNext = false;return new Promise(resolve => { delayed = () => resolve(view); }); }
    return view;
  });
  assert.equal($('usage-switch').checked, false);assert.equal($('usage-switch').disabled, false);
  $('usage-switch').checked = true;$('usage-switch').change();await settle();
  assert.deepEqual(calls, [{ enabled: true }]);
  assert.equal($('usage-state').textContent, '已开启');
  assert.equal($('delegation-switch').checked, false, 'usage consent cannot enable delegation');
  delayNext = true;await poll();
  $('usage-switch').checked = false;$('usage-switch').change();await settle();
  delayed();await settle();
  assert.equal($('usage-switch').checked, false, 'an old ON snapshot cannot restore consent');
  rejectSave = true;
  $('usage-switch').checked = true;$('usage-switch').change();await settle();
  assert.equal($('usage-switch').checked, false);
  assert.match($('usage-message').textContent, /保存失败/);
});

test('old backend leaves usage control disabled with reload guidance', async () => {
  const { $ } = await panelFixture(async () => ({
    delegation: { enabled: false, executor: 'dsh' }, worker: { executors: { dsh: { models: [] } } },
  }));
  assert.equal($('usage-switch').disabled, true);
  assert.match($('usage-message').textContent, /重启插件后台/);
});

test('first visible connected board requests one daily check and shows an available update while collapsed', async () => {
  let checks = 0;
  const { $, document, documentEvents, runTimers } = await panelFixture(async name => {
    assert.equal(name, 'panel_snapshot');
    return { delegation: { enabled: false, executor: 'dsh' }, worker: { executors: { dsh: { online: true, models: [] } } } };
  }, { hidden: true, dailyUpdate: async (name, input) => {
    assert.equal(name, 'panel_update');assert.equal(input.action, 'check_daily');checks++;
    return { status: 'available', current: 'aaa', latest: 'bbb' };
  } });
  assert.equal(checks, 0);
  document.hidden = false;documentEvents.get('visibilitychange')();await settle();
  assert.equal(checks, 1);
  assert.equal($('update').open, false, 'notification does not force the card open');
  assert.equal($('update-summary-meta').textContent, '发现可用更新');
  assert.equal($('update-apply').disabled, false);
  await runTimers();await runTimers();
  document.hidden = true;documentEvents.get('visibilitychange')();
  document.hidden = false;documentEvents.get('visibilitychange')();await settle();
  assert.equal(checks, 1, 'snapshot polling and visibility changes do not repeat the daily request');
});

test('an automatic check uses bounded local status reads and never requests installation', async () => {
  const actions = [];
  const { $, runTimers } = await panelFixture(async (name, input) => {
    if (name === 'panel_snapshot') return { delegation: { enabled: false, executor: 'dsh' }, worker: { executors: { dsh: { models: [] } } } };
    actions.push(input.action);
    return { status: 'checking' };
  }, { dailyUpdate: async (name, input) => {
    actions.push(input.action);return { status: 'checking' };
  } });
  for (let n = 0; n < 12; n++) await runTimers();
  assert.deepEqual(actions, ['check_daily', ...Array(8).fill('status')]);
  assert.match($('update-message').textContent, /刷新状态/);
});

test('model picker distinguishes providers, saves a route, resets on executor change and reports rejected saves', async () => {
  let setting = { enabled: false, executor: 'dsh' };let rejectSave = false;
  const calls = [];
  const models = [{ provider: 'one', model: 'same-id', name: 'Model one' }, { provider: 'two', model: 'same-id', name: 'Model two' }];
  const { $, poll } = await panelFixture(async (name, input) => {
    calls.push({ name, input: JSON.parse(JSON.stringify(input)) });
    if (name === 'panel_settings') {
      if (rejectSave) throw new Error('所选模型当前不可用');
      setting = JSON.parse(JSON.stringify(input));return setting;
    }
    return { delegation: setting, worker: { executors: { dsh: { online: true, models }, hermes: { online: false, models: [] } } } };
  });
  assert.deepEqual(calls[0].input, { refresh_models: true });
  const select = $('delegation-model');
  assert.equal(select.children.length, 3);assert.notEqual(select.children[1].value, select.children[2].value);
  assert.equal(select.disabled, false);
  select.value = select.children[2].value;select.change();await settle();
  assert.deepEqual(setting.route, { provider: 'two', model: 'same-id' });
  assert.equal(select.value, JSON.stringify(['two', 'same-id']));
  const replacements = select.replacements;await poll();assert.equal(select.replacements, replacements);
  rejectSave = true;select.value = select.children[1].value;select.change();await settle();
  assert.equal(select.value, JSON.stringify(['two', 'same-id']));
  assert.match($('delegation-message').textContent, /保存失败.*不可用/);
  rejectSave = false;$('delegation-executor').value = 'hermes';$('delegation-executor').change();await settle();
  assert.deepEqual(setting, { enabled: false, executor: 'hermes' });assert.equal(select.value, '');
  assert.equal(select.disabled, true);assert.match($('model-help').textContent, /Hermes 未连接/);
  assert.ok(calls.some(call => call.name === 'panel_snapshot' && call.input.executor === 'hermes' && call.input.refresh_models));
});

test('an old polling response cannot revert a newly saved switch or hide a missing selected model', async () => {
  const route = { provider: 'account', model: 'removed' };
  let setting = { enabled: true, executor: 'dsh', route };let delayed;
  let snapshots = 0;
  const { $, poll } = await panelFixture(async (name, input) => {
    if (name === 'panel_settings') { setting = JSON.parse(JSON.stringify(input));return setting; }
    const view = { delegation: JSON.parse(JSON.stringify(setting)), worker: { executors: { dsh: { online: true, models: [{ provider: 'account', model: 'available' }] } } } };
    if (++snapshots === 2) return new Promise(resolve => { delayed = () => resolve(view); });
    return view;
  });
  assert.match($('model-help').textContent, /所选模型当前不可用/);
  assert.equal($('delegation-model').children.at(-1).disabled, true);
  await poll();$('delegation-switch').checked = false;$('delegation-switch').change();await settle();
  assert.equal(setting.enabled, false);assert.deepEqual(setting.route, route);
  delayed();await settle();assert.equal($('delegation-switch').checked, false);
  await poll();assert.equal($('delegation-switch').checked, false);
});

test('saved ON is pending while the hook is untrusted, and trust readiness never claims an old chat is loaded', async () => {
  let activation = { status: 'untrusted' };let setting = { enabled: true, executor: 'dsh' };
  const { $, poll } = await panelFixture(async (name, input) => {
    if (name === 'panel_settings') { setting = JSON.parse(JSON.stringify(input));return setting; }
    return { delegation: setting, activation, worker: { executors: { dsh: { online: true, models: [] } } } };
  });
  assert.match($('delegation-state').textContent, /待生效/);
  assert.match($('activation-message').textContent, /尚未生效.*\/hooks.*信任/);
  assert.equal($('online-label').textContent, 'DSH 已连接');
  $('delegation-switch').checked = false;$('delegation-switch').change();await settle();
  $('delegation-switch').checked = true;$('delegation-switch').change();await settle();
  assert.equal($('delegation-message').textContent, '设置已保存。');assert.match($('delegation-state').textContent, /待生效/);
  activation = { status: 'ready' };await poll();
  assert.equal($('delegation-state').textContent, '已开启');
  assert.match($('activation-message').textContent, /Hook 已信任.*旧会话请先重新加载/);
  activation = { status: 'unknown' };await poll();assert.match($('delegation-state').textContent, /未确认/);
  assert.match($('activation-message').textContent, /不代表派工已生效/);
});

test('panel polling pauses when hidden or clipped, refreshes on return, and stops after teardown', async () => {
  const source = await readFile(new URL('../src/monitor-client.js', import.meta.url), 'utf8');
  const timers = new Map();const elements = new Map();const documentEvents = new Map();
  let nextTimer = 1;let requests = 0;let teardown;let intersection;let disconnected = false;
  const element = () => ({ checked: false, disabled: false, value: '', textContent: '', className: '',
    classList: { toggle() {}, remove() {} }, append() {}, replaceChildren() {}, addEventListener() {} });
  const document = { hidden: false, documentElement: {},
    getElementById(id) { if (!elements.has(id)) elements.set(id, element());return elements.get(id); },
    createElement: element, querySelectorAll: () => [],
    addEventListener(name, callback) { documentEvents.set(name, callback); },
  };
  const window = { addEventListener() {}, agentsHost: {
    onClose(callback) { teardown = callback; },
    async call(name) {
      if (name === 'panel_update') return { status: 'idle' };
      assert.equal(name, 'panel_snapshot');requests++;
      return { delegation: { enabled: false, executor: 'hermes' }, worker: { online: false, executors: { hermes: {}, dsh: {} } }, warnings: [], agents: [], orders: [], summary: {} };
    },
  } };
  vm.runInNewContext(source, { document, window,
    setTimeout(callback) { const id = nextTimer++;timers.set(id, callback);return id; },
    clearTimeout(id) { timers.delete(id); },
    IntersectionObserver: class { constructor(callback) { intersection = callback; } observe() {} disconnect() { disconnected = true; } },
  });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();assert.equal(requests, 1);assert.equal(timers.size, 1);
  document.hidden = true;documentEvents.get('visibilitychange')();
  assert.equal(timers.size, 0);await settle();assert.equal(requests, 1);
  document.hidden = false;documentEvents.get('visibilitychange')();
  await settle();assert.equal(requests, 2);
  intersection([{ isIntersecting: false }]);assert.equal(timers.size, 0);
  intersection([{ isIntersecting: true }]);await settle();assert.equal(requests, 3);
  teardown();assert.equal(timers.size, 0);assert.equal(disconnected, true);
  documentEvents.get('visibilitychange')();await settle();assert.equal(requests, 3);
});

test('thinking strength follows the selected catalog model, clears on model/executor change, and explains missing options', async () => {
  const models = [
    { provider: 'p', model: 'fast', name: 'Fast', efforts: ['low', 'high'], default_effort: 'low' },
    { provider: 'p', model: 'plain', name: 'Plain' },
  ];
  let setting = { enabled: true, executor: 'dsh', route: { provider: 'p', model: 'fast' }, effort: 'max' };
  const calls = [];
  const { $ } = await panelFixture(async (name, input) => {
    calls.push({ name, input: JSON.parse(JSON.stringify(input)) });
    if (name === 'panel_settings') { setting = JSON.parse(JSON.stringify(input));return setting; }
    return { delegation: setting, activation: { status: 'ready' }, worker: { executors: {
      dsh: { online: true, models }, hermes: { online: false, models: [] },
    } } };
  });
  const model = $('delegation-model');
  const effort = $('delegation-effort');
  assert.equal(model.value, JSON.stringify(['p', 'fast']));
  assert.deepEqual(effort.children.map(option => option.value), ['', 'low', 'high', 'max']);
  assert.equal(effort.children.at(-1).disabled, true, 'an unavailable pinned strength stays visible but disabled');
  assert.equal(effort.value, 'max');
  assert.match($('effort-help').textContent, /所选思考强度当前不可用/);
  effort.value = 'high';effort.change();await settle();
  assert.deepEqual(setting, { enabled: true, executor: 'dsh', route: { provider: 'p', model: 'fast' }, effort: 'high' });
  assert.equal(effort.disabled, false);
  assert.match($('effort-help').textContent, /目录默认强度为 low/);
  // Switching the model clears the pinned strength before saving.
  model.value = JSON.stringify(['p', 'plain']);model.change();await settle();
  assert.deepEqual(setting, { enabled: true, executor: 'dsh', route: { provider: 'p', model: 'plain' } });
  assert.equal(effort.value, '');
  assert.equal(effort.disabled, true);
  assert.match($('effort-help').textContent, /未提供思考强度选项/);
  // A model with catalog efforts can pin a strength again; following default sends none.
  model.value = JSON.stringify(['p', 'fast']);model.change();await settle();
  assert.equal(effort.value, '');
  assert.equal(effort.disabled, false);
  effort.value = 'low';effort.change();await settle();
  assert.equal(setting.effort, 'low');
  effort.value = '';effort.change();await settle();
  assert.equal(setting.effort, undefined);
  // Changing the executor clears the route and the strength together.
  $('delegation-executor').value = 'hermes';$('delegation-executor').change();await settle();
  assert.deepEqual(setting, { enabled: true, executor: 'hermes' });
  assert.equal(effort.value, '');
  assert.equal(effort.disabled, true);
  assert.match($('effort-help').textContent, /Hermes 未连接/);
  assert.ok(calls.some(call => call.name === 'panel_settings' && call.input.effort === 'high'));
});

test('update card reads cached status on open, allows manual checks, and pauses the bounded status poll while hidden', async () => {
  let checked = false;let applies = 0;let polls = 0;
  const calls = [];
  const { $, document, documentEvents, timers, runTimers } = await panelFixture(async (name, input) => {
    if (name === 'panel_snapshot') {
      return { delegation: { enabled: false, executor: 'dsh' }, worker: { executors: { dsh: { online: true, models: [] } } } };
    }
    assert.equal(name, 'panel_update');
    calls.push(input.action);
    if (input.action === 'status') {
      if (applies) {
        polls++;
        return { status: polls >= 2 ? 'updated' : 'updating', current: '2222222', latest: '2222222', branch: 'main', message: '更新完成。', restart_required: true };
      }
      if (checked) return { status: 'available', current: '1111111', latest: '2222222', branch: 'main', message: '发现 2 个新提交。' };
      return { status: 'idle', current: '1111111', branch: 'main' };
    }
    if (input.action === 'check') {
      checked = true;
      return { status: 'checking', current: '1111111', branch: 'main' };
    }
    applies++;
    return { status: 'updating', current: '1111111', branch: 'main' };
  });
  // Daily checks use the fixture's separate dailyUpdate handler. Card actions
  // below still read cached status and allow an explicit manual check.
  assert.deepEqual(calls, []);
  $('update').open = true;$('update').toggle();await settle();
  assert.deepEqual(calls, ['status']);
  assert.equal($('update-message').textContent, '尚未检查更新。');
  assert.equal($('update-check').disabled, false);
  assert.equal($('update-apply').disabled, true);
  assert.equal($('update-current').textContent, '1111111');
  // The check button bypasses the automatic daily throttle. The
  // helper answers with an active state, so a bounded status poll follows.
  $('update-check').click();await settle();
  assert.deepEqual(calls, ['status', 'check']);
  assert.equal($('update-message').textContent, '正在检查更新…');
  assert.equal($('update-check').disabled, true);
  assert.equal($('update-refresh').disabled, false, 'read-only status refresh stays available while checking');
  // The finite poll pauses while hidden and resumes on return.
  document.hidden = true;documentEvents.get('visibilitychange')();assert.equal(timers.size, 0);
  document.hidden = false;documentEvents.get('visibilitychange')();await settle();
  assert.ok(timers.size > 0);
  await runTimers();
  assert.match($('update-message').textContent, /发现 2 个新提交/);
  assert.equal($('update-latest').textContent, '2222222');
  assert.equal($('update-apply').disabled, false);
  assert.equal($('update-check').disabled, false);
  // Apply starts another finite poll until the update settles.
  $('update-apply').click();await settle();
  assert.deepEqual(calls.slice(-1), ['apply']);
  assert.equal($('update-message').textContent, '正在安装更新…');
  assert.equal($('update-check').disabled, true);
  assert.equal($('update-refresh').disabled, false, 'read-only status refresh stays available while updating');
  await runTimers();
  await runTimers();
  assert.match($('update-message').textContent, /请重新加载 Codex/);
  assert.equal($('update-apply').disabled, true);
  const settled = calls.filter(action => action === 'status').length;
  await runTimers();await runTimers();
  assert.equal(calls.filter(action => action === 'status').length, settled, 'no permanent update polling after settling');
});

test('a stuck update stops after a bounded number of status polls and refresh can re-read it', async () => {
  let applies = 0;let statusCalls = 0;let finish = false;
  const { $, runTimers } = await panelFixture(async (name, input) => {
    if (name === 'panel_snapshot') {
      return { delegation: { enabled: false, executor: 'dsh' }, worker: { executors: { dsh: { online: true, models: [] } } } };
    }
    if (input.action === 'status') {
      statusCalls++;
      if (finish) return { status: 'available', pending_install: false, current: 'a'.repeat(7), latest: 'b'.repeat(7), branch: 'main', message: '发现可用更新。' };
      return { status: applies ? 'updating' : 'available', current: 'a'.repeat(7), latest: 'b'.repeat(7), branch: 'main' };
    }
    if (input.action === 'check') return { status: 'available', current: 'a'.repeat(7), latest: 'b'.repeat(7), branch: 'main' };
    applies++;
    return { status: 'updating', current: 'a'.repeat(7), latest: 'b'.repeat(7), branch: 'main' };
  });
  $('update').open = true;$('update').toggle();await settle();
  $('update-check').click();await settle();
  $('update-apply').click();await settle();
  const before = statusCalls;
  for (let attempt = 0; attempt < 12; attempt++) await runTimers();
  assert.equal(statusCalls - before, 8, 'apply polls status a bounded number of times');
  // The poll budget runs out while the backend still reports updating: the
  // read-only refresh must stay available instead of leaving the card stuck.
  assert.match($('update-message').textContent, /刷新状态/);
  assert.equal($('update-refresh').disabled, false);
  assert.equal($('update-check').disabled, true);
  const settled = statusCalls;
  for (let attempt = 0; attempt < 3; attempt++) await runTimers();
  assert.equal(statusCalls, settled, 'no permanent update polling after the bounded budget');
  // Manual refreshes stay usable for as long as the helper is still busy.
  $('update-refresh').click();await settle();
  assert.match($('update-message').textContent, /正在安装更新/);
  assert.equal($('update-refresh').disabled, false);
  // A pending install can flip to available in the background; a later refresh
  // picks it up and re-enables apply without restarting check/apply.
  finish = true;
  $('update-refresh').click();await settle();
  assert.match($('update-message').textContent, /发现可用更新/);
  assert.equal($('update-apply').disabled, false);
  assert.equal($('update-check').disabled, false);
  assert.equal($('update-refresh').disabled, false);
});

test('a transient status error keeps the last update state and a manual refresh can recover', async () => {
  let applies = 0;let failStatus = false;
  const { $, runTimers } = await panelFixture(async (name, input) => {
    if (name === 'panel_snapshot') {
      return { delegation: { enabled: false, executor: 'dsh' }, worker: { executors: { dsh: { online: true, models: [] } } } };
    }
    if (input.action === 'status') {
      if (failStatus) throw new Error('看板连接超时');
      return applies
        ? { status: 'updated', current: 'b'.repeat(7), latest: 'b'.repeat(7), branch: 'main', message: '更新完成。' }
        : { status: 'available', current: 'a'.repeat(7), latest: 'b'.repeat(7), branch: 'main' };
    }
    if (input.action === 'check') return { status: 'available', current: 'a'.repeat(7), latest: 'b'.repeat(7), branch: 'main' };
    applies++;
    return { status: 'updating', current: 'a'.repeat(7), latest: 'b'.repeat(7), branch: 'main' };
  });
  $('update').open = true;$('update').toggle();await settle();
  $('update-check').click();await settle();
  $('update-apply').click();await settle();
  failStatus = true;
  await runTimers();
  // A dropped connection is reported as a retryable read error, never as a
  // final install failure, and the last known state stays visible.
  assert.match($('update-message').textContent, /状态读取失败/);
  assert.match($('update-message').textContent, /正在安装更新/);
  assert.doesNotMatch($('update-message').textContent, /更新失败/);
  assert.equal($('update-latest').textContent, 'b'.repeat(7));
  assert.equal($('update-refresh').disabled, false);
  failStatus = false;
  $('update-refresh').click();await settle();
  assert.match($('update-message').textContent, /更新完成/);
  assert.equal($('update-refresh').disabled, false);
});

test('a blocked pending install keeps retry-apply available without offering it for plain blocks', async () => {
  let pending = true;let applies = 0;
  const calls = [];
  const { $, runTimers } = await panelFixture(async (name, input) => {
    if (name === 'panel_snapshot') {
      return { delegation: { enabled: false, executor: 'dsh' }, worker: { executors: { dsh: { online: true, models: [] } } } };
    }
    assert.equal(name, 'panel_update');
    calls.push(input.action);
    if (input.action === 'status') {
      return {
        status: 'blocked', ...(pending ? { pending_install: true } : {}),
        current: 'a'.repeat(7), latest: 'b'.repeat(7), branch: 'main', reason: pending ? 'pending_install' : 'dirty',
        message: pending ? '上次安装未完成，已停止更新。' : '本地有未提交改动，已停止更新。',
      };
    }
    if (input.action === 'check') return { status: 'checking', current: 'a'.repeat(7), latest: 'b'.repeat(7), branch: 'main' };
    applies++;
    return { status: 'updating', pending_install: true, current: 'a'.repeat(7), latest: 'b'.repeat(7), branch: 'main' };
  });
  $('update').open = true;$('update').toggle();await settle();
  // Blocked + pending_install is recoverable: the backend resumes the install.
  assert.equal($('update-apply').disabled, false);
  assert.match($('update-message').textContent, /重试安装/);
  assert.equal($('update-refresh').disabled, false);
  assert.equal($('update-check').disabled, false);
  // A plain block (no pending install) must not offer apply.
  pending = false;
  $('update-refresh').click();await settle();
  assert.equal($('update-apply').disabled, true);
  assert.match($('update-message').textContent, /未提交改动/);
  // The pending install comes back (for example after a failed recovery) and the
  // retry entry returns.
  pending = true;
  $('update-refresh').click();await settle();
  assert.equal($('update-apply').disabled, false);
  // Retry apply starts the detached helper and the finite status poll.
  $('update-apply').click();await settle();
  assert.ok(calls.includes('apply'));
  assert.equal($('update-check').disabled, true);
  assert.equal($('update-refresh').disabled, false);
  assert.equal($('update-apply').disabled, true, 'apply cannot be repeated while the helper is running');
  await runTimers();
  assert.equal($('update-apply').disabled, false, 'a still-blocked recovery can be retried again');
});

test('the DSH permission picker shows only for DSH and saves native preset names', async () => {
  let setting = { enabled: true, executor: 'dsh', dsh_permission: 'read-only' };
  const calls = [];
  const { $ } = await panelFixture(async (name, input) => {
    calls.push({ name, input: JSON.parse(JSON.stringify(input)) });
    if (name === 'panel_settings') { setting = JSON.parse(JSON.stringify(input));return setting; }
    return { delegation: JSON.parse(JSON.stringify(setting)), worker: { executors: {
      dsh: { online: true, models: [], permission_control: { available: true, presets: ['read-only', 'workspace-write', 'danger-full-access'] } },
      hermes: { online: true, models: [] },
    } } };
  });
  const field = $('permission-field');
  const select = $('delegation-permission');
  assert.equal(field.hidden, false);
  assert.equal(select.value, 'read-only');
  assert.equal(select.disabled, false);
  assert.match($('permission-help').textContent, /仅 DSH 新派工会话生效/);
  // Every explicit choice is saved as the native preset key, never as a pair.
  select.value = 'danger-full-access';select.change();await settle();
  assert.equal(setting.dsh_permission, 'danger-full-access');
  assert.equal(select.value, 'danger-full-access');
  // Following the DSH default sends "default" so a stale saved choice clears.
  select.value = '';select.change();await settle();
  assert.equal(setting.dsh_permission, 'default');
  // Hermes hides the field and never carries the DSH-only preference over.
  $('delegation-executor').value = 'hermes';$('delegation-executor').change();await settle();
  assert.equal(field.hidden, true);
  assert.deepEqual(setting, { enabled: true, executor: 'hermes' });
  assert.ok(!calls.some(call => call.name === 'panel_settings' && call.input.executor === 'hermes' && 'dsh_permission' in call.input));
});

test('a rejected DSH permission save reverts the picker and keeps the field usable', async () => {
  let setting = { enabled: true, executor: 'dsh', dsh_permission: 'workspace-write' };
  let reject = false;
  const { $ } = await panelFixture(async (name, input) => {
    if (name === 'panel_settings') {
      if (reject) throw new Error('DSH 未连接，无法保存');
      setting = JSON.parse(JSON.stringify(input));return setting;
    }
    return { delegation: JSON.parse(JSON.stringify(setting)), worker: { executors: {
      dsh: { online: true, models: [], permission_control: { available: true, presets: ['read-only', 'workspace-write', 'danger-full-access'] } },
    } } };
  });
  const select = $('delegation-permission');
  reject = true;select.value = 'danger-full-access';select.change();await settle();
  assert.equal(select.value, 'workspace-write', 'a failed save restores the last persisted permission');
  assert.match($('delegation-message').textContent, /保存失败.*DSH 未连接/);
  assert.equal(select.disabled, false, 'the picker is usable again after the failure');
  reject = false;select.value = 'read-only';select.change();await settle();
  assert.equal(setting.dsh_permission, 'read-only');
});

test('an old DSH consumer without permission control disables every non-default choice', async () => {
  // The heartbeat comes from the plugin code that is actually running. An old
  // consumer omits permission_control, so the board must not show a setting the
  // old end would silently ignore; only the DSH default stays selectable.
  let setting = { enabled: true, executor: 'dsh', dsh_permission: 'danger-full-access' };
  const calls = [];
  const { $ } = await panelFixture(async (name, input) => {
    calls.push({ name, input: JSON.parse(JSON.stringify(input)) });
    if (name === 'panel_settings') { setting = JSON.parse(JSON.stringify(input));return setting; }
    return { delegation: JSON.parse(JSON.stringify(setting)), worker: { executors: {
      dsh: { online: true, models: [] },
    } } };
  });
  const field = $('permission-field');
  const select = $('delegation-permission');
  assert.equal(field.hidden, false);
  assert.deepEqual(select.children.map(option => option.value), ['', 'read-only', 'workspace-write', 'danger-full-access']);
  assert.equal(select.children[0].disabled, false);
  for (const option of select.children.slice(1)) assert.equal(option.disabled, true);
  assert.equal(select.children.at(-1).textContent, '完全权限（当前不可用）');
  assert.equal(select.value, 'danger-full-access');
  assert.equal(select.disabled, false, 'the user can still choose the DSH default');
  assert.match($('permission-help').textContent, /未加载新会话权限控制.*重新加载.*重启 DSH/);
  select.value = '';select.change();await settle();
  assert.ok(calls.some(call => call.name === 'panel_settings' && call.input.dsh_permission === 'default'));
});

test('offline or partially capable DSH consumers keep unsupported presets disabled', async () => {
  let setting = { enabled: true, executor: 'dsh' };
  let online = false;
  let presets = ['read-only', 'workspace-write', 'danger-full-access'];
  const { $, poll } = await panelFixture(async (name, input) => {
    if (name === 'panel_settings') { setting = JSON.parse(JSON.stringify(input));return setting; }
    return { delegation: JSON.parse(JSON.stringify(setting)), worker: { executors: {
      dsh: { online, models: [], permission_control: { available: true, presets } },
    } } };
  });
  const select = $('delegation-permission');
  // Offline: the board cannot verify the running plugin, so explicit choices
  // stay disabled while the default remains selectable.
  assert.equal(select.children[0].disabled, false);
  for (const option of select.children.slice(1)) assert.equal(option.disabled, true);
  assert.match($('permission-help').textContent, /DSH 未连接/);
  // Reconnect with only one native preset: disable exactly the missing ones.
  online = true;presets = ['read-only'];
  await poll();
  assert.equal(select.children[1].disabled, false);
  assert.equal(select.children[2].disabled, true);
  assert.equal(select.children[3].disabled, true);
  assert.match($('permission-help').textContent, /未提供：工作区内修改、完全权限/);
});

test('auto-update switch persists separately, starts a daily check when enabled, and restores a failed save', async () => {
  let enabled = false;let fail = false;let status = 'idle';const actions = [];
  const state = () => ({ status, auto_update: enabled });
  const { $, runTimers } = await panelFixture(async (name, input) => {
    if (name === 'panel_snapshot') return { delegation: { enabled: false, executor: 'dsh' }, worker: { executors: { dsh: { models: [] } } } };
    assert.equal(name, 'panel_update');actions.push(JSON.parse(JSON.stringify(input)));
    if (input.action === 'set_auto') {
      if (fail) throw new Error('save failed');
      enabled = input.enabled;
    }
    return state();
  }, { dailyUpdate: async () => { actions.push({ action: 'check_daily' });return state(); } });
  assert.equal($('auto-update-switch').checked, false);
  assert.equal($('auto-update-switch').disabled, false);
  $('auto-update-switch').checked = true;$('auto-update-switch').change();await settle();await settle();
  assert.deepEqual(actions.slice(-2), [{ action: 'set_auto', enabled: true }, { action: 'check_daily' }]);
  assert.equal($('auto-update-state').textContent, '已开启');
  assert.equal($('delegation-switch').checked, false);
  status = 'updating';$('update-refresh').click();await settle();
  assert.equal($('auto-update-switch').disabled, false, 'a running install does not prevent turning future auto updates off');
  $('auto-update-switch').checked = false;$('auto-update-switch').change();await settle();
  assert.equal($('auto-update-state').textContent, '已关闭');
  assert.ok(!actions.some(input => input.action === 'apply'), 'the server owns automatic installation');
  status = 'idle';fail = true;
  $('auto-update-switch').checked = true;$('auto-update-switch').change();await settle();
  assert.equal($('auto-update-switch').checked, false);
  assert.match($('update-message').textContent, /save failed/);
  await runTimers();
});

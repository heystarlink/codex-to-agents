import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const settle = () => new Promise(resolve => setImmediate(resolve));
async function panelFixture(call) {
  const timers = new Map();const elements = new Map();let nextTimer = 0;
  const element = () => ({ checked: false, disabled: false, value: '', textContent: '', className: '', children: [], replacements: 0,
    classList: { toggle() {}, remove() {} },
    replaceChildren(...children) { this.children = children;this.replacements++; },
    addEventListener(name, callback) { this[name] = callback; },
  });
  const document = { hidden: false, documentElement: {}, addEventListener() {}, createElement: element,
    getElementById(id) { if (!elements.has(id)) elements.set(id, element());return elements.get(id); },
  };
  const source = await readFile(new URL('../src/monitor-client.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, { document, window: { addEventListener() {}, agentsHost: { onClose() {}, call } },
    setTimeout(callback) { const id = nextTimer++;timers.set(id, callback);return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  await settle();
  return { $: id => elements.get(id), async poll() { const [id, fn] = timers.entries().next().value;timers.delete(id);fn();await settle(); } };
}

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

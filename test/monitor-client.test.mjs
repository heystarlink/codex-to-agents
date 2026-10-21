import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

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

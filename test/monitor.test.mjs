import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, access, readFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from 'node:http';
import { OrderBook } from '../src/orders.mjs';
import { monitorSnapshot, renderTerminal, filterOrders } from '../src/monitor.mjs';
import { monitorWeb } from '../src/monitor-web.mjs';

async function fixture(t) {
  const root = await mkdtemp('/tmp/cta-monitor-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'data');
  const book = new OrderBook(home);await book.open();
  return { root, home, book };
}

test('an absent data folder is an empty offline view and monitoring creates no files', async t => {
  const root = await mkdtemp('/tmp/cta-empty-');t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'absent');
  const snapshot = await monitorSnapshot(home);
  assert.equal(snapshot.worker.online, false);assert.equal(snapshot.summary.total, 0);
  assert.deepEqual(snapshot.agents, []);
  await assert.rejects(access(home), { code: 'ENOENT' });
  assert.ok(renderTerminal(snapshot).includes('暂无执行会话'));
});

test('native Agent state is separate from task state and becomes unknown when heartbeat expires', async t => {
  const { book, home } = await fixture(t);
  const task = await book.submit('work_submit', { goal: 'hello', model: 'flash', title: '测试任务' });
  await book.transition(task.order_id, 'completed', { conversation_id: 'native-1', route: { model: 'flash', provider: 'account' }, output: { text: 'done' } });
  const now = Date.now();
  await book.runtime({ active: true, at: new Date(now).toISOString(), sessions: [{ id: 'native-1', status: 'running' }] });
  const fresh = await monitorSnapshot(home, { now });
  assert.equal(fresh.orders[0].status, 'completed');assert.equal(fresh.agents[0].status, 'running');
  const stale = await monitorSnapshot(home, { now: now + 7000 });
  assert.equal(stale.worker.online, false);assert.equal(stale.agents[0].status, 'unknown');
  assert.equal(stale.orders[0].status, 'completed');
  assert.equal(stale.agents[0].stale, true);
});

test('counts include the full history, limited rows remain read-only, and corrupt records do not hide healthy ones', async t => {
  const { home, book } = await fixture(t);
  const first = await book.submit('work_submit', { goal: 'one' });
  const second = await book.submit('work_submit', { goal: 'two' });
  await book.transition(first.order_id, 'failed', { error: 'expected error' });
  const before = await readFile(join(home, 'states', `${first.order_id}.json`), 'utf8');
  await writeFile(join(home, 'states', `${second.order_id}.json`), '{broken');
  const view = await monitorSnapshot(home, { limit: 1 });
  assert.equal(view.summary.total, 1);assert.equal(view.summary.problems, 1);assert.equal(view.warnings.length, 1);
  assert.equal(await readFile(join(home, 'states', `${first.order_id}.json`), 'utf8'), before);
  const queued = await book.submit('work_submit', { goal: 'three' });
  const next = await monitorSnapshot(home, { limit: 1 });
  assert.equal(next.summary.total, 2);assert.equal(next.orders.length, 1);
  const all = await monitorSnapshot(home);
  assert.equal(filterOrders(all.orders, 'active')[0].order_id, queued.order_id);
  assert.equal(filterOrders(all.orders, 'problems')[0].order_id, first.order_id);
});

test('terminal output strips injected control sequences and shows offline execution as stale', async t => {
  const { home, book } = await fixture(t);
  const task = await book.submit('work_submit', { goal: 'hello', title: '\u001b[31munsafe title' });
  await book.transition(task.order_id, 'executing', { conversation_id: 'agent-1' });
  const text = renderTerminal(await monitorSnapshot(home), { width: 120 });
  assert.ok(!text.includes('\u001b'));assert.ok(text.includes('状态已过期'));
  assert.ok(text.includes('未知'));assert.ok(text.includes('q 退出'));
});

test('monitor separates identical session IDs and freshness across DSH and Hermes', async t => {
  const { book, home } = await fixture(t);
  const dsh = await book.submit('work_submit', { goal: 'DSH work' });
  const hermes = await book.submit('work_submit', { executor: 'hermes', goal: 'Hermes work' });
  for (const order of [dsh, hermes]) await book.transition(order.order_id, 'executing', { conversation_id: 'same-id' });
  const now = Date.now();
  await book.runtime({ active: true, at: new Date(now - 7000).toISOString(), sessions: [{ id: 'same-id', status: 'running' }] });
  await book.runtime({ active: true, at: new Date(now).toISOString(), sessions: [{ id: 'same-id', status: 'idle' }] }, 'hermes');
  const view = await monitorSnapshot(home, { now });
  assert.equal(view.worker.online, true);assert.equal(view.agents.length, 2);
  assert.equal(view.agents.find(agent => agent.executor === 'dsh').status, 'unknown');
  assert.equal(view.agents.find(agent => agent.executor === 'hermes').status, 'idle');
  assert.equal(view.orders.find(order => order.executor === 'dsh').stale, true);
  assert.equal(view.orders.find(order => order.executor === 'hermes').stale, false);
});

test('Qoder is a first-class executor in the monitor, including catalog diagnostics', async t => {
  const { book, home } = await fixture(t);
  const qoder = await book.submit('work_submit', { executor: 'qoder', goal: 'Qoder work', model: 'Auto' });
  await book.transition(qoder.order_id, 'executing', { conversation_id: 'qoder-session' });
  const now = Date.now();
  await book.runtime({ active: true, at: new Date(now).toISOString(), catalog: { models: [{ provider: 'qoder', model: 'Auto', name: 'Auto', efforts: [] }], error: 'Qoder CLI 未登录：请先登录。' }, sessions: [{ id: 'qoder-session', status: 'running' }] }, 'qoder');
  const view = await monitorSnapshot(home, { now });
  assert.equal(view.worker.online, true);
  assert.equal(view.worker.executors.qoder.online, true);
  assert.deepEqual(view.worker.executors.qoder.models.map(model => model.model), ['Auto']);
  assert.match(view.worker.executors.qoder.catalog_error, /未登录/);
  assert.equal(view.agents.find(agent => agent.executor === 'qoder').status, 'running');
  assert.equal(view.orders.find(order => order.order_id === qoder.order_id).stale, false);
  const stale = await monitorSnapshot(home, { now: now + 7000 });
  assert.equal(stale.worker.executors.qoder.online, false);
  assert.equal(stale.agents.find(agent => agent.executor === 'qoder').status, 'unknown');
});

test('model catalogs stay scoped to each executor, including catalog failures', async t => {
  const { book, home } = await fixture(t);
  const models = [{ provider: 'account', model: 'flash', name: 'Flash' }];
  await book.runtime({ active: true, at: new Date().toISOString(), catalog: { models } });
  await book.runtime({ active: false, at: new Date().toISOString(), catalog: { models: [], error: 'unavailable' } }, 'hermes');
  const { executors } = (await monitorSnapshot(home)).worker;
  assert.deepEqual(executors.dsh.models, models);assert.equal(executors.dsh.catalog_error, null);
  assert.deepEqual(executors.hermes.models, []);assert.equal(executors.hermes.catalog_error, 'unavailable');
});

test('the snapshot passes through native permission control per executor', async t => {
  const { book, home } = await fixture(t);
  const permission_control = { available: true, presets: ['read-only', 'workspace-write', 'danger-full-access'] };
  await book.runtime({ active: true, at: new Date().toISOString(), catalog: { models: [], permission_control } });
  // An older consumer's heartbeat simply has no permission_control: the board
  // must receive null and disable non-default choices instead of assuming it.
  await book.runtime({ active: true, at: new Date().toISOString(), catalog: { models: [] } }, 'hermes');
  const { executors } = (await monitorSnapshot(home)).worker;
  assert.deepEqual(executors.dsh.permission_control, permission_control);
  assert.equal(executors.hermes.permission_control, null);
});

test('web settings page serves a settings-only snapshot and needs no work-order history', async t => {
  const { home, book } = await fixture(t);
  const marker = 'HTTP-SETTINGS-MARKER';
  const order = await book.submit('work_submit', { goal: `${marker} goal`, title: `${marker} title` });
  await writeFile(join(home, 'states', `${order.order_id}.json`), '{broken');
  // A settings-only server must not acquire or scan the history: this would
  // fail before it can serve a single page.
  await chmod(join(home, 'requests'), 0o000);
  await chmod(join(home, 'states'), 0o000);
  let server;
  try {
    server = await monitorWeb(home, { port: 0 });
    const html = await fetch(server.url);assert.equal(html.status, 200);
    assert.ok(html.headers.get('content-security-policy').includes("script-src 'self'"));
    const script = await (await fetch(server.url + '/monitor-client.js')).text();
    assert.ok(script.includes('textContent'));assert.ok(!script.includes('innerHTML'));
    const allowed = ['delegation', 'generated_at', 'service', 'usage', 'warnings', 'worker'];
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(server.url + '/api/snapshot');
      assert.equal(response.status, 200);
      const snapshot = await response.json();
      assert.deepEqual(Object.keys(snapshot).sort(), allowed, 'the shared settings page returns no monitor bodies');
      assert.ok(!JSON.stringify(snapshot).includes(marker));
      assert.deepEqual(snapshot.warnings, []);
    }
    assert.equal((await fetch(server.url + '/api/snapshot', { method: 'POST' })).status, 405);
    assert.equal((await fetch(server.url + '/../../etc/passwd')).status, 404);
    assert.equal((await fetch(server.url + '/api/snapshot', { headers: { Origin: 'https://example.org' } })).status, 403);
    const status = await new Promise((resolve, reject) => {
      const req = request(server.url + '/api/snapshot', { headers: { Host: 'example.org' } }, res => { res.resume();resolve(res.statusCode); });
      req.on('error', reject);req.end();
    });
    assert.equal(status, 403);
  } finally {
    await chmod(join(home, 'requests'), 0o700);
    await chmod(join(home, 'states'), 0o700);
    await server?.close();
  }
});

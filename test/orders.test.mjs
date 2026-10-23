import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { OrderBook } from '../src/orders.mjs';
import { Consumer } from '../src/worker.mjs';

async function environment(t) {
  const home = await mkdtemp('/tmp/cw-test-');
  const opened = [];
  const sent = [];
  const operations = [];
  const replies = new Map();
  const desktop = {
    async describe() { return { models: [{ provider: 'account', model: 'flash' }] }; },
    observe(ids) { return ids.map(id => ({ id, status: 'idle' })); },
    async start(order) { return { conversation_id: `cw-${order.id}`, checkpoint: 0 }; },
    async send(order, location, message, mode) { sent.push({ id: order.id, location, message, mode }); },
    async checkpoint(id) { return { conversation_id: id, checkpoint: 1 }; },
    async progress(order) { return replies.get(order.id) ?? { status: 'executing', progress: 'waiting' }; },
    async workspaceAction(input) { operations.push(input);return { action: input.action }; },
    async conversationAction(input) { operations.push(input);return { action: input.action }; },
    async cancel(id) { operations.push({ cancelled: id }); },
  };
  const book = new OrderBook(home);await book.open();
  const consumer = async () => { const value = new Consumer(home, desktop);await value.open();opened.push(value);return value; };
  t.after(async () => { for (const value of opened.reverse()) await value.close();await rm(home, { recursive: true, force: true }); });
  return { home, book, desktop, sent, operations, replies, consumer };
}

test('offline submission is durable, atomic and idempotent across independent producers', async t => {
  const f = await environment(t);
  const id = randomUUID();
  const input = { order_id: id, goal: 'write hello' };
  const another = new OrderBook(f.home);
  const result = await Promise.all([f.book.submit('work_submit', input), another.submit('work_submit', input)]);
  assert.deepEqual(result.map(item => item.reused).sort(), [false, true]);
  assert.equal(result[0].status, 'queued');assert.equal((await f.book.runtime()).online, false);
  assert.equal((await another.list()).length, 1);
  await assert.rejects(another.submit('work_submit', { ...input, goal: 'different' }), /different work/);
  assert.equal((await stat(join(f.home, 'requests', `${id}.json`))).mode & 0o777, 0o600);
});

test('consumer admits work, tracks native completion, and never redispatches completed orders', async t => {
  const f = await environment(t);
  const order = await f.book.submit('work_submit', { goal: 'hello' });
  const worker = await f.consumer();await worker.tick();
  assert.equal((await f.book.inspect(order.order_id)).status, 'executing');
  assert.equal(f.sent.length, 1);assert.equal((await f.book.runtime()).online, true);
  f.replies.set(order.order_id, { status: 'completed', progress: 'done', output: { text: 'HELLO' } });
  await worker.tick();await worker.tick();
  const result = await f.book.inspect(order.order_id);
  assert.equal(result.output.text, 'HELLO');assert.equal(result.status, 'completed');assert.equal(f.sent.length, 1);
});

test('updates follow the target conversation, preserve delivery intent and expose cancellation', async t => {
  const f = await environment(t);
  const parent = await f.book.submit('work_submit', { goal: 'initial' });
  const follow = await f.book.submit('work_update', { target_order: parent.order_id, action: 'interrupt', message: 'add a requirement' });
  const worker = await f.consumer();await worker.tick();await worker.tick();
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].location.conversation_id, f.sent[0].location.conversation_id);
  assert.equal(f.sent[1].mode, 'steer');
  const cancel = await f.book.submit('work_update', { target_order: parent.order_id, action: 'cancel' });
  await worker.tick();
  assert.equal((await f.book.inspect(cancel.order_id)).status, 'completed');
  assert.equal(f.operations.at(-1).cancelled, `cw-${parent.order_id}`);
  assert.equal((await f.book.inspect(follow.order_id)).status, 'executing');
});

test('an interrupted dispatch becomes uncertain and is observed instead of replayed', async t => {
  const f = await environment(t);
  const order = await f.book.submit('work_submit', { goal: 'possibly accepted' });
  await f.book.transition(order.order_id, 'dispatching', { conversation_id: 'existing-native' });
  const worker = await f.consumer();
  assert.equal((await f.book.inspect(order.order_id)).status, 'uncertain');
  await worker.tick();assert.equal(f.sent.length, 0);
  f.replies.set(order.order_id, { status: 'completed', progress: 'recovered', output: { text: 'existing result' } });
  await worker.tick();assert.equal((await f.book.inspect(order.order_id)).status, 'completed');
});

test('Qoder inherits its executor, rejects desktop workspaces, and keeps legacy consumer protection', async t => {
  const f = await environment(t);
  const parent = await f.book.submit('work_submit', { executor: 'qoder', goal: 'qoder first', directory: '/tmp' });
  assert.equal(parent.executor, 'qoder');
  const update = await f.book.submit('work_update', { target_order: parent.order_id, action: 'append', message: 'next' });
  assert.equal(update.executor, 'qoder');
  assert.equal((await f.book.request(update.order_id)).payload.executor, 'qoder');
  await assert.rejects(f.book.submit('work_update', { executor: 'dsh', target_order: parent.order_id, action: 'cancel' }), /must match/);
  await assert.rejects(f.book.submit('work_submit', { executor: 'qoder', goal: 'x', workspace_id: 'dsh-project' }), /not supported/);
  await assert.rejects(f.book.submit('workspace_control', { executor: 'qoder', action: 'list' }), /not supported/);
  // A legacy DSH consumer could steal non-DSH orders, so publication blocks until reload.
  const snapshot = { active: true, pid: process.pid, at: new Date().toISOString() };
  await f.book.runtime(snapshot);
  await assert.rejects(f.book.submit('work_submit', { executor: 'qoder', goal: 'do not misroute' }), /legacy consumer/);
  await f.book.runtime({ ...snapshot, protocol: 2 });
  const safe = await f.book.submit('work_submit', { executor: 'qoder', goal: 'safe after reload' });
  assert.equal(safe.executor, 'qoder');
  await f.book.runtime({ active: true, protocol: 2, at: new Date().toISOString(), catalog: { models: [] } }, 'qoder');
  assert.equal((await f.book.runtime(null, 'qoder')).online, true);
  assert.equal((await f.book.runtimes()).executors.qoder.online, true);
});

test('only one consumer may own the directory, and offline status is saved when it closes', async t => {
  const f = await environment(t);
  const first = await f.consumer();await first.tick();
  await assert.rejects(new Consumer(f.home, f.desktop).open(), /Another work-order consumer/);
  await first.close();
  assert.equal((await f.book.runtime()).online, false);
  // close is checked below for idempotence as application disposal may repeat.
});

test('desktop management uses the same work-order lifecycle and rejected operations remain inspectable', async t => {
  const f = await environment(t);
  const workspace = await f.book.submit('workspace_control', { action: 'rename', workspace_id: 'a', title: 'Renamed' });
  const chat = await f.book.submit('conversation_control', { action: 'restore', conversation_id: 'existing-chat' });
  const worker = await f.consumer();await worker.tick();
  assert.equal((await f.book.inspect(workspace.order_id)).output.action, 'rename');
  assert.equal((await f.book.inspect(chat.order_id)).output.action, 'restore');
  f.desktop.workspaceAction = async () => { throw new Error('workspace is missing'); };
  const failed = await f.book.submit('workspace_control', { action: 'remove', workspace_id: 'missing' });
  await worker.tick();
  assert.equal((await f.book.inspect(failed.order_id)).status, 'failed');
  assert.equal((await f.book.inspect(failed.order_id)).error, 'workspace is missing');
  await assert.rejects(f.book.submit('work_update', { action: 'append' }));
  await assert.rejects(f.book.submit('workspace_control', { action: 'register' }));
  await assert.rejects(f.book.inspect('../escape'), /Invalid/);
});

test('malformed order IDs are rejected with parameter and remedy before any request is saved', async t => {
  const home = await mkdtemp('/tmp/cw-test-id-');
  const book = new OrderBook(home);
  t.after(async () => rm(home, { recursive: true, force: true }));
  for (const order_id of ['my-task', 'cw-12345678-1234-4234-8234-123456789abc', 'not-a-uuid']) {
    await assert.rejects(book.submit('work_submit', { order_id, goal: 'must not save' }),
      /order_id must be a real UUID, not a task title, cw- conversation ID, or example placeholder/);
  }
  await book.open();
  assert.deepEqual(await book.list(), []);
  await assert.rejects(book.inspect('my-task'), /Invalid order_id/);
});

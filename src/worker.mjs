import { readFile, unlink, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { OrderBook, TERMINAL } from './orders.mjs';

async function lease(home) {
  const file = join(home, 'consumer.lock');
  const identity = { pid: process.pid, nonce: randomUUID() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(file, JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
      return async () => {
        const current = JSON.parse(await readFile(file, 'utf8'));
        if (current.nonce === identity.nonce) await unlink(file);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const current = JSON.parse(await readFile(file, 'utf8'));
      try { process.kill(current.pid, 0);throw new Error('Another work-order consumer owns this directory.'); }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      await unlink(file);
    }
  }
  throw new Error('Could not claim the work-order directory.');
}

export class Consumer {
  constructor(home, desktop) {
    this.book = new OrderBook(home);
    this.desktop = desktop;
    this.tail = Promise.resolve();
    this.closed = false;
    this.catalog = null;
    this.nextCatalog = 0;
  }

  async open() {
    await this.book.open();
    const stat = await lstat(this.book.home);
    if (stat.isSymbolicLink()) throw new Error('Work-order directory may not be a symlink.');
    this.release = await lease(this.book.home);
    // A process may have died after a side effect but before saving its reply.
    // Mark those orders uncertain; never automatically submit them again.
    try {
      for (const state of await this.book.list()) {
        if (state.status === 'dispatching') await this.book.transition(state.order_id, 'uncertain', {
          conversation_id: state.conversation_id ?? (state.kind === 'work_submit' ? `cw-${state.order_id}` : undefined),
          progress: 'Consumer restarted during dispatch; inspecting native history instead of replaying.',
        });
      }
    } catch (error) { await this.release();throw error; }
  }

  tick() {
    this.tail = this.tail.catch(() => {}).then(() => this.closed ? undefined : this.process());
    return this.tail;
  }

  async process() {
    if (Date.now() >= this.nextCatalog) {
      try { this.catalog = await this.desktop.describe(); }
      catch (error) { this.catalog = { error: error.message }; }
      this.nextCatalog = Date.now() + 15000;
    }
    const orders = await this.book.list();
    const sessions = this.desktop.observe(orders.map(order => order.conversation_id).filter(Boolean));
    await this.book.runtime({ active: true, at: new Date().toISOString(), pid: process.pid, catalog: this.catalog, sessions });
    for (const state of orders) {
      if (TERMINAL.has(state.status)) continue;
      const order = await this.book.request(state.order_id);
      if (['executing', 'uncertain'].includes(state.status)) {
        if (state.conversation_id) {
          try {
            const change = await this.desktop.progress(order, state);
            if (change.status !== state.status || change.progress !== state.progress) {
              await this.book.transition(order.id, change.status, change);
            }
          } catch (error) {
            if (state.progress !== error.message) await this.book.transition(order.id, 'uncertain', { progress: error.message });
          }
        }
        continue;
      }
      if (state.status === 'queued') await this.dispatch(order);
    }
  }

  async dispatch(order) {
    let location;
    let startedDelivery = false;
    try {
      const input = order.payload;
      if (order.kind === 'work_update' && input.target_order) {
        const target = await this.book.inspect(input.target_order);
        if (!target.conversation_id) {
          if (TERMINAL.has(target.status)) throw new Error('The target work order did not create a conversation.');
          return; // Preserve dependency ordering without creating duplicate chats.
        }
        location = { conversation_id: target.conversation_id };
      }
      await this.book.transition(order.id, 'dispatching');
      if (order.kind === 'work_submit') {
        location = await this.desktop.start(order);
        await this.book.transition(order.id, 'dispatching', location);
        startedDelivery = true;
        await this.desktop.send(order, location, input.goal, 'queue');
        await this.book.transition(order.id, 'executing', { progress: 'Message submitted to DSH.' });
      } else if (order.kind === 'work_update') {
        const sessionId = location?.conversation_id ?? input.conversation_id;
        if (input.action === 'cancel') {
          await this.desktop.cancel(sessionId);
          await this.book.transition(order.id, 'completed', { output: { cancellation_requested: true, conversation_id: sessionId, queued_messages_retained: true } });
        } else {
          location = await this.desktop.checkpoint(sessionId);
          await this.book.transition(order.id, 'dispatching', location);
          startedDelivery = true;
          await this.desktop.send(order, location, input.message, input.action === 'interrupt' ? 'steer' : 'queue');
          await this.book.transition(order.id, 'executing', { progress: 'Follow-up submitted to DSH.' });
        }
      } else {
        const output = order.kind === 'workspace_control' ? await this.desktop.workspaceAction(input)
          : await this.desktop.conversationAction(input);
        await this.book.transition(order.id, 'completed', { output });
      }
    } catch (error) {
      await this.book.transition(order.id, startedDelivery ? 'uncertain' : 'failed', {
        error: error.message, progress: startedDelivery ? 'Submission outcome is uncertain; automatic replay is disabled.' : error.message,
      });
    }
  }

  async close() {
    if (!this.closing) {
      this.closed = true;
      this.closing = (async () => {
        await this.tail.catch(() => {});
        await this.book.runtime({ active: false, at: new Date().toISOString(), catalog: this.catalog });
        await this.release?.();
      })();
    }
    return this.closing;
  }
}

import { Consumer } from './worker.mjs';
import { Hermes } from './hermes.mjs';

// The shared backend or a standalone worker may offer to consume Hermes work.
// Only the lease owner runs it; another worker can take over after it exits.
export function startHermesWorker(home, settings, { interval = 750, onError = () => {} } = {}) {
  let consumer;
  let closed = false;
  let pending;
  let lastError;
  const tick = () => {
    if (closed || pending) return;
    pending = (async () => {
      if (!consumer) {
        const candidate = new Consumer(home, new Hermes({ ...settings, home }), { executor: 'hermes' });
        try { await candidate.open();consumer = candidate; }
        catch (error) { if (error.code === 'CONSUMER_BUSY') return;throw error; }
      }
      await consumer.tick();lastError = null;
    })().catch(error => {
      if (error.message !== lastError) onError(error);
      lastError = error.message;
    }).finally(() => { pending = null; });
  };
  const timer = setInterval(tick, interval);
  tick();
  return {
    ready: pending,
    async close() {
      closed = true;clearInterval(timer);
      await pending;
      await consumer?.close();
    },
  };
}

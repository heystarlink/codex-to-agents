import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { leaseFile } from './executors.mjs';
import { acquireOrderIndex, releaseOrderIndex } from './order-cache.mjs';

const json = async path => {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null;throw error; }
};

// Lazily start one spawned-CLI consumer (Hermes, Qoder) from the shared
// backend. Nothing stays resident without a saved configuration and unfinished
// work: the check reads the shared metadata index instead of reparsing every
// completed request and state file on each timer tick. `load` resolves the
// executor's worker module (injectable for tests).
export function lazyExecutor(home, {
  executor, settingsKey, load, interval = 2000, onError = () => {},
} = {}) {
  if (!executor || !settingsKey || typeof load !== 'function') throw new Error('A lazy executor needs its name, settings key and worker loader.');
  let worker;let pending;let closed = false;let errorText;
  let configuration;
  let indexPromise;
  let unsubscribe;
  const state = { loaded: false, external_owner_pid: null };
  const index = () => {
    indexPromise ??= (async () => {
      try {
        const value = await acquireOrderIndex(home);
        if (!closed) unsubscribe ??= value.onChange(() => { void check(); });
        return value;
      } catch (error) {
        // A transient open failure must not latch: the next timer pass retries.
        indexPromise = null;
        throw error;
      }
    })();
    return indexPromise;
  };
  const check = ({ force = false } = {}) => {
    if (closed) return;
    if (pending) return pending.then(() => force && !worker && !state.external_owner_pid ? check({ force }) : undefined);
    pending = (async () => {
      const settings = await json(join(home, 'settings.json'));
      const nextConfiguration = JSON.stringify(settings?.[settingsKey]);
      if (worker && configuration === nextConfiguration) return worker.ready;
      if (worker) { await worker.close();worker = null; }
      configuration = nextConfiguration;
      if (!settings?.[settingsKey]) return;
      const lease = await json(join(home, leaseFile(executor)));
      if (lease?.pid && lease.pid !== process.pid) {
        try { process.kill(lease.pid, 0);state.external_owner_pid = lease.pid;return; }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      state.external_owner_pid = null;
      const book = await index();
      await book.sync();
      if (!force && !book.pending(executor).length) return;
      const module = await load();
      // Shared contract is startExecutorWorker; the legacy named exports stay
      // accepted so existing worker fixtures keep working.
      const start = module.startExecutorWorker ?? module[`start${executor[0].toUpperCase()}${executor.slice(1)}Worker`];
      if (typeof start !== 'function') throw new Error(`The ${executor} worker module does not export startExecutorWorker.`);
      if (closed) return;
      worker = start(home, settings[settingsKey], { onError });state.loaded = true;
      await worker.ready;
    })().catch(error => {
      if (error.message !== errorText) onError(error);
      errorText = error.message;
    }).finally(() => { pending = null; });
    return pending;
  };
  const timer = setInterval(check, interval);check();
  return {
    state, check,
    async close() {
      closed = true;
      clearInterval(timer);
      unsubscribe?.();
      unsubscribe = null;
      await pending;
      await worker?.close();
      if (indexPromise) {
        const acquired = indexPromise.catch(() => null);
        indexPromise = null;
        const value = await acquired;
        if (value) await releaseOrderIndex(value);
      }
    },
  };
}

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { leaseFile } from './executors.mjs';

const terminal = new Set(['completed', 'failed', 'cancelled', 'blocked']);
const json = async path => {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null;throw error; }
};

// Lazily start one spawned-CLI consumer (Hermes, Qoder) from the shared
// backend. Nothing stays resident without a saved configuration and unfinished
// work: the check itself only reads small JSON files. `load` resolves the
// executor's worker module (injectable for tests).
export function lazyExecutor(home, {
  executor, settingsKey, load, interval = 2000, onError = () => {},
} = {}) {
  if (!executor || !settingsKey || typeof load !== 'function') throw new Error('A lazy executor needs its name, settings key and worker loader.');
  let worker;let pending;let closed = false;let errorText;
  let configuration;
  const state = { loaded: false, external_owner_pid: null };
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
      let files;
      try { files = await readdir(join(home, 'requests')); }
      catch (error) { if (error.code === 'ENOENT') files = [];else throw error; }
      let needed = force;
      for (const file of files.filter(name => /^[0-9a-f-]{36}\.json$/.test(name))) {
        const request = await json(join(home, 'requests', file));
        if (request?.payload.executor !== executor) continue;
        const saved = await json(join(home, 'states', file));
        if (terminal.has(saved?.status)) continue;
        needed = true;break;
      }
      if (!needed) return;
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
  return { state, check, async close() { closed = true;clearInterval(timer);await pending;await worker?.close(); } };
}

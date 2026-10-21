import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const terminal = new Set(['completed', 'failed', 'cancelled', 'blocked']);
const json = async path => {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null;throw error; }
};

export function lazyHermes(home, { interval = 2000, load = () => import('./hermes-worker.mjs'), onError = () => {} } = {}) {
  let worker;let pending;let closed = false;let errorText;
  let configuration;
  const state = { loaded: false, external_owner_pid: null };
  const check = ({ force = false } = {}) => {
    if (closed) return;
    if (pending) return pending.then(() => force && !worker && !state.external_owner_pid ? check({ force }) : undefined);
    pending = (async () => {
      const settings = await json(join(home, 'settings.json'));
      const nextConfiguration = JSON.stringify(settings?.hermes);
      if (worker && configuration === nextConfiguration) return worker.ready;
      if (worker) { await worker.close();worker = null; }
      configuration = nextConfiguration;
      if (!settings?.hermes) return;
      const lease = await json(join(home, 'consumer-hermes.lock'));
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
        if (request?.payload.executor !== 'hermes') continue;
        const saved = await json(join(home, 'states', file));
        if (terminal.has(saved?.status)) continue;
        needed = true;break;
      }
      if (!needed) return;
      const { startHermesWorker } = await load();
      if (closed) return;
      worker = startHermesWorker(home, settings.hermes, { onError });state.loaded = true;
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

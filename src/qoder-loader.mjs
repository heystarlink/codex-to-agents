import { lazyExecutor } from './executor-loader.mjs';

// Qoder is loaded on demand from the shared backend: no configuration or no
// unfinished Qoder work means no worker (and therefore no CLI process) at all.
export function lazyQoder(home, { interval = 2000, load = () => import('./qoder-worker.mjs'), onError = () => {} } = {}) {
  return lazyExecutor(home, { executor: 'qoder', settingsKey: 'qoder', interval, load, onError });
}

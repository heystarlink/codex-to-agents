import { lazyExecutor } from './executor-loader.mjs';

export function lazyHermes(home, { interval = 2000, load = () => import('./hermes-worker.mjs'), onError = () => {} } = {}) {
  return lazyExecutor(home, { executor: 'hermes', settingsKey: 'hermes', interval, load, onError });
}

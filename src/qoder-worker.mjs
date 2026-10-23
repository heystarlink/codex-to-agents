import { startConsumer } from './worker.mjs';
import { Qoder } from './qoder.mjs';

// The shared backend or a standalone worker may offer to consume Qoder work.
// No Qoder CLI process is kept alive while idle: each order owns one short-lived
// headless child, so an unconfigured or empty queue spawns nothing.
export function startQoderWorker(home, settings, options = {}) {
  return startConsumer({
    home, executor: 'qoder', ...options,
    create: () => new Qoder({ ...settings, home }),
  });
}

// Shared lazy-loader contract: the module exposes one factory for its executor.
export const startExecutorWorker = startQoderWorker;

import { startConsumer } from './worker.mjs';
import { Hermes } from './hermes.mjs';

// The shared backend or a standalone worker may offer to consume Hermes work.
// Only the lease owner runs it; another worker can take over after it exits.
export function startHermesWorker(home, settings, options = {}) {
  return startConsumer({
    home, executor: 'hermes', ...options,
    create: () => new Hermes({ ...settings, home }),
  });
}

// Shared lazy-loader contract: the module exposes one factory for its executor.
export const startExecutorWorker = startHermesWorker;

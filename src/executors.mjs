// One shared list of execution ends keeps the order schema, runtime heartbeats,
// consumer leases, board catalogs and update idle checks in step. Keep this
// module dependency-free: the installed DSH runtime snapshot copies it and has
// no access to the rest of the repo.
export const EXECUTORS = Object.freeze(['dsh', 'hermes', 'qoder']);

export const isExecutor = value => EXECUTORS.includes(value);

// DSH keeps its historical filenames so existing installations and old
// consumers keep reading the same heartbeat and lease after an upgrade.
export const runtimeFile = executor => isExecutor(executor)
  ? (executor === 'dsh' ? 'runtime.json' : `runtime-${executor}.json`)
  : null;

export const leaseFile = executor => isExecutor(executor)
  ? (executor === 'dsh' ? 'consumer.lock' : `consumer-${executor}.lock`)
  : null;

export const executorLabel = executor => executor === 'hermes' ? 'Hermes' : executor === 'dsh' ? 'DSH' : executor === 'qoder' ? 'Qoder' : String(executor ?? '');

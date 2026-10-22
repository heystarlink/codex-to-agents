import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectHooks, hookHealth } from '../src/hook-health.mjs';

function nativeFixture(response) {
  const requests = [];let killed = false;
  const launch = (_command, args, options) => {
    assert.deepEqual(args, ['app-server']);assert.equal(options.stdio[2], 'ignore');
    const child = new EventEmitter();child.stdout = new PassThrough();
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      const message = JSON.parse(chunk.toString());requests.push(message);
      if (message.id === 1) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n'));
      if (message.id === 2 && response) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: 2, ...response }) + '\n'));
      done();
    } });
    child.kill = () => { killed = true;child.stdout.end();queueMicrotask(() => child.emit('close')); };
    return child;
  };
  return { launch, requests, killed: () => killed };
}

const nativeHook = (trustStatus, enabled = true) => ({ pluginId: 'agents-board@codex-to-agents-local',
  eventName: 'userPromptSubmit', trustStatus, enabled, command: 'read-current-preference', sourcePath: '/plugin/hooks/hooks.json' });

test('native hook inspection reports actual trust, modification and enabled states using read-only methods', async () => {
  for (const [trust, enabled, expected] of [['untrusted', true, 'untrusted'], ['modified', true, 'modified'], ['trusted', true, 'ready'], ['trusted', false, 'disabled']]) {
    const fixture = nativeFixture({ result: { data: [{ errors: [], hooks: [nativeHook(trust, enabled)] }] } });
    const result = await inspectHooks('/path with spaces/codex', '/cwd', fixture);
    assert.equal(result.status, expected);
    assert.deepEqual(fixture.requests.map(request => request.method), ['initialize', 'initialized', 'hooks/list']);
    assert.deepEqual(fixture.requests[2].params.cwds, ['/cwd']);assert.equal(fixture.killed(), true);
  }
});

test('a missing hook differs from inspection errors, malformed responses and timeout; every native process closes', async () => {
  const absent = nativeFixture({ result: { data: [{ errors: [], hooks: [] }] } });
  assert.equal((await inspectHooks('codex', '/cwd', absent)).status, 'missing');
  for (const response of [{ error: { message: 'unsupported' } }, { result: {} }, { result: { data: [{ hooks: [], errors: [{ message: 'invalid hooks' }] }] } }]) {
    const fixture = nativeFixture(response);
    await assert.rejects(inspectHooks('codex', '/cwd', fixture));assert.equal(fixture.killed(), true);
  }
  const stalled = nativeFixture();
  await assert.rejects(inspectHooks('codex', '/cwd', { ...stalled, timeout: 20 }), /timed out/);
  assert.equal(stalled.killed(), true);
});

async function homeFixture(t) {
  const home = await mkdtemp('/tmp/cta-hook-health-');t.after(() => rm(home, { recursive: true, force: true }));
  const codexHome = join(home, 'codex');await mkdir(codexHome);
  return { home, codexHome };
}

test('visible panels share one cached inspection and a trust config change triggers a fresh check without writing trust', async t => {
  const { home, codexHome } = await homeFixture(t);
  await writeFile(join(home, 'plugin-installation.json'), JSON.stringify({ codex: '/configured/codex' }));
  const config = join(codexHome, 'config.toml');await writeFile(config, '# no trust');
  let calls = 0;let time = 0;let status = 'untrusted';let changes = 0;
  const health = hookHealth(home, { codexHome, now: () => time, interval: 1000, onChange: () => { changes++; },
    probe: async command => { calls++;assert.equal(command, '/configured/codex');return { status }; } });
  t.after(() => health.close());
  assert.equal(health.snapshot().status, 'checking');
  await Promise.all([health.check(), health.check(), health.check()]);assert.equal(calls, 1);
  assert.equal(health.snapshot().status, 'untrusted');assert.equal(await readFile(config, 'utf8'), '# no trust');
  await health.check();assert.equal(calls, 1);
  status = 'ready';await writeFile(config, '# user reviewed the current hook');await health.check();
  assert.equal(health.snapshot().status, 'ready');assert.equal(calls, 2);assert.equal(changes, 2);
  time = 1001;await health.check();assert.equal(calls, 3);
  assert.equal(await readFile(config, 'utf8'), '# user reviewed the current hook');
});

test('missing installation and failed checks never report readiness, and backend shutdown cancels pending inspection', async t => {
  const { home, codexHome } = await homeFixture(t);let calls = 0;
  const absent = hookHealth(home, { codexHome, probe: () => { calls++; } });
  await absent.check();assert.equal(absent.snapshot().status, 'missing_installation');assert.equal(calls, 0);await absent.close();
  await writeFile(join(home, 'plugin-installation.json'), JSON.stringify({ codex: 'codex' }));
  const early = hookHealth(home, { codexHome, probe: () => { throw new Error('must not start after shutdown'); } });
  const closing = early.check();await early.close();await closing;assert.equal(early.snapshot().status, 'checking');
  const failed = hookHealth(home, { codexHome, probe: async () => { throw new Error('CLI unavailable'); } });
  await failed.check();assert.equal(failed.snapshot().status, 'unknown');await failed.close();
  let started;const running = new Promise(resolve => { started = resolve; });let aborted = false;
  const pending = hookHealth(home, { codexHome, probe: (_command, _cwd, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true;reject(new Error('closed')); });started();
  }) });
  const check = pending.check();await running;await pending.close();await check;assert.equal(aborted, true);
});

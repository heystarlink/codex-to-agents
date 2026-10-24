import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcp } from '../src/mcp.mjs';
import { startBackend } from '../src/backend.mjs';
import { backendAuth } from '../src/backend-control.mjs';
import { monitorSnapshot } from '../src/monitor.mjs';
import { createUsageReporter, saveUsageSetting, usageStatus, USAGE_ENDPOINT } from '../src/usage.mjs';

async function fixture(t) {
  const home = await mkdtemp('/tmp/cta-usage-');
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}
const readState = async home => JSON.parse(await readFile(join(home, 'usage-state.json'), 'utf8'));
const version = async () => '0.1.0';
const success = () => new Response('{"ok":true}', { status: 200 });
async function linked(t, home, panelOnly) {
  const server = await createMcp(home, { panelOnly });
  const client = new Client({ name: 'usage-test', version: '1.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);await client.connect(b);
  t.after(async () => { await client.close();await server.close(); });
  return client;
}

test('default ON: status stays read-only and activity sends one allowlisted report', async t => {
  const root = await fixture(t);const home = join(root, 'absent');
  const requests = [];
  const reporter = createUsageReporter(home, { now: () => Date.parse('2026-10-23T12:00:00Z'), version,
    fetchImpl: async (url, init) => { requests.push({ url, init });return success(); } });
  t.after(() => reporter.close());
  assert.deepEqual(await usageStatus(home), { enabled: true, last_sent_day: null });
  await assert.rejects(access(home), { code: 'ENOENT' }, 'a status read never creates the data directory');
  await reporter.activity();
  assert.equal(requests.length, 1);
  const saved = await readState(home);
  assert.match(saved.installation_id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(saved.last_sent_day, '2026-10-23');
  assert.deepEqual(JSON.parse(requests[0].init.body), { installation_id: saved.installation_id, version: '0.1.0' });
  assert.deepEqual(Object.keys(JSON.parse(requests[0].init.body)).sort(), ['installation_id', 'version']);
  assert.deepEqual(await usageStatus(home), { enabled: true, last_sent_day: '2026-10-23' });
  assert.deepEqual(await readdir(home), ['usage-state.json'], 'the missing preference is never rewritten');
});

test('saved OFF stays effective across a reporter restart without an ID or request', async t => {
  const home = await fixture(t);await saveUsageSetting(home, false);
  let requests = 0;
  const options = { now: () => Date.parse('2026-10-23T12:00:00Z'), version,
    fetchImpl: async () => { requests++;return success(); } };
  let reporter = createUsageReporter(home, options);
  await reporter.activity();reporter.close();
  reporter = createUsageReporter(home, options);t.after(() => reporter.close());
  await reporter.activity();
  assert.equal(requests, 0);
  assert.deepEqual(await usageStatus(home), { enabled: false, last_sent_day: null });
  assert.deepEqual(JSON.parse(await readFile(join(home, 'usage-settings.json'), 'utf8')), { enabled: false });
  await assert.rejects(access(join(home, 'usage-state.json')), { code: 'ENOENT' });
});

test('saved OFF keeps restarted shared backends silent', async t => {
  const home = await fixture(t);await saveUsageSetting(home, false);
  let requests = 0;
  const usageOptions = { version, fetchImpl: async () => { requests++;return success(); } };
  const connectAndInspect = async () => {
    const backend = await startBackend(home, { usageOptions });
    const client = new Client({ name: 'usage-off-backend', version: '1.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(backend.url + '/mcp'), { requestInit: { headers: await backendAuth(home) } }));
      await client.callTool({ name: 'work_inspect', arguments: {} });
      await delay(50);
    } finally { await client.close();await backend.close(); }
  };
  await connectAndInspect();await connectAndInspect();
  assert.equal(requests, 0);
  assert.deepEqual(await usageStatus(home), { enabled: false, last_sent_day: null });
  await assert.rejects(access(join(home, 'usage-state.json')), { code: 'ENOENT' });
});

test('concurrent sessions, restart and UTC rollover share one persistent private ID', async t => {
  const home = await fixture(t);await saveUsageSetting(home, true);
  let clock = Date.parse('2026-10-23T23:59:00Z');
  const requests = [];
  const options = { now: () => clock, version, fetchImpl: async (url, init) => {
    requests.push({ url, init });return success();
  } };
  let reporter = createUsageReporter(home, options);
  t.after(() => reporter.close());
  await Promise.all(Array.from({ length: 12 }, () => reporter.activity()));
  const saved = await readState(home);
  assert.match(saved.installation_id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(saved.last_sent_day, '2026-10-23');
  assert.equal((await stat(join(home, 'usage-state.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(home, 'usage-settings.json'))).mode & 0o777, 0o600);
  reporter.close();reporter = createUsageReporter(home, options);
  await reporter.activity();assert.equal(requests.length, 1);
  clock = Date.parse('2026-10-24T00:00:00Z');
  await reporter.activity();assert.equal(requests.length, 2);
  for (const { url, init } of requests) {
    assert.equal(url, USAGE_ENDPOINT);assert.equal(init.redirect, 'error');
    assert.deepEqual(init.headers, { 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(init.body), { installation_id: saved.installation_id, version: '0.1.0' });
  }
  const snapshot = await monitorSnapshot(home);
  assert.equal(snapshot.usage.enabled, true);
  assert.equal(snapshot.usage.last_sent_day, '2026-10-24');
  assert.ok(!JSON.stringify(snapshot).includes(saved.installation_id));
});

test('network failure is silent, attempted only once per UTC day including restart', async t => {
  const home = await fixture(t);await saveUsageSetting(home, true);
  let requests = 0;let clock = Date.parse('2026-10-23T12:00Z');
  const options = { version, now: () => clock, fetchImpl: async () => { requests++;throw new Error('private path or token'); } };
  let reporter = createUsageReporter(home, options);
  await reporter.activity();await reporter.activity();reporter.close();
  reporter = createUsageReporter(home, options);t.after(() => reporter.close());
  await reporter.activity();assert.equal(requests, 1);
  const first = await readState(home);
  assert.deepEqual(await usageStatus(home), { enabled: true, last_sent_day: null });
  clock += 86400000;await reporter.activity();assert.equal(requests, 2);
  assert.equal((await readState(home)).installation_id, first.installation_id);
});

test('HTTP rejection is not successful and does not retry that day', async t => {
  const home = await fixture(t);await saveUsageSetting(home, true);
  let requests = 0;
  const reporter = createUsageReporter(home, { version, fetchImpl: async () => { requests++;return new Response('unavailable', { status: 503 }); } });
  t.after(() => reporter.close());
  await reporter.activity();await reporter.activity();
  assert.equal(requests, 1);assert.equal((await usageStatus(home)).last_sent_day, null);
});

test('opting out aborts in-flight upload and leaves unrelated preferences untouched', async t => {
  const home = await fixture(t);await saveUsageSetting(home, true);
  await writeFile(join(home, 'delegation.json'), '{"enabled":false,"executor":"dsh"}');
  await writeFile(join(home, 'sdd-workspace.json'), '{"enabled":true,"directory":"/private/docs"}');
  let started;const ready = new Promise(resolve => { started = resolve; });
  let aborted = false;let requests = 0;
  const reporter = createUsageReporter(home, { version, fetchImpl: async (_url, init) => {
    requests++;started();
    return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => { aborted = true;reject(new Error('aborted')); }, { once: true }));
  } });
  t.after(() => reporter.close());
  const pending = reporter.activity();await ready;
  await saveUsageSetting(home, false);reporter.settingsChanged(false);
  await pending;await reporter.activity();
  assert.equal(aborted, true);assert.equal(requests, 1);
  assert.equal((await usageStatus(home)).enabled, false);
  assert.equal(await readFile(join(home, 'delegation.json'), 'utf8'), '{"enabled":false,"executor":"dsh"}');
  assert.equal(await readFile(join(home, 'sdd-workspace.json'), 'utf8'), '{"enabled":true,"directory":"/private/docs"}');
});

test('opting out while preparation is pending prevents both ID creation and upload', async t => {
  const home = await fixture(t);await saveUsageSetting(home, true);
  let release;let started;const ready = new Promise(resolve => { started = resolve; });
  let requests = 0;
  const reporter = createUsageReporter(home, { version: () => { started();return new Promise(resolve => { release = resolve; }); },
    fetchImpl: async () => { requests++;return success(); } });
  t.after(() => reporter.close());
  const pending = reporter.activity();await ready;
  await saveUsageSetting(home, false);reporter.settingsChanged(false);release('0.1.0');await pending;
  assert.equal(requests, 0);await assert.rejects(access(join(home, 'usage-state.json')), { code: 'ENOENT' });
});

test('timeout cancels a slow upload and close prevents later activity', async t => {
  // Deterministic clock: on a loaded parallel suite the fixed 15 ms timeout may
  // fire during preparation I/O before fetch starts, so the request is skipped
  // correctly but a wall-clock assertion would flake. Wait until the fake fetch
  // has actually begun, then advance the mocked timer.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const home = await fixture(t);await saveUsageSetting(home, true);
  let aborted = false;let requests = 0;let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const reporter = createUsageReporter(home, { version: async () => '0.1.0', timeoutMs: 15, fetchImpl: async (_url, init) => {
    requests++;started();
    return new Promise((resolve, reject) => {
      if (init.signal.aborted) { aborted = true;reject(new Error('aborted'));return; }
      init.signal.addEventListener('abort', () => { aborted = true;reject(new Error('aborted')); }, { once: true });
    });
  } });
  t.after(() => reporter.close());
  const pending = reporter.activity();
  await startedPromise;
  t.mock.timers.tick(15);
  await pending;
  assert.equal(aborted, true);
  assert.equal(requests, 1);
  reporter.close();
  await reporter.activity();
  assert.equal(requests, 1, 'close prevents later requests');
});

test('corrupt consent or installation state fails closed instead of generating a new identity', async t => {
  const home = await fixture(t);let requests = 0;
  const reporter = createUsageReporter(home, { version, fetchImpl: async () => { requests++;return success(); } });
  t.after(() => reporter.close());
  for (const value of ['{bad', 'null', '{"enabled":"true"}', '{"enabled":true,"endpoint":"https://evil.example"}']) {
    await writeFile(join(home, 'usage-settings.json'), value);
    await reporter.activity();assert.equal((await usageStatus(home)).enabled, false);
  }
  await saveUsageSetting(home, true);
  for (const value of ['{bad', 'null', '{"installation_id":"private-path"}']) {
    await writeFile(join(home, 'usage-state.json'), value);await reporter.activity();
    assert.equal(await readFile(join(home, 'usage-state.json'), 'utf8'), value);
  }
  assert.equal(requests, 0);
});

test('consent tool is app-only, boolean-only and cannot override destination or ID', async t => {
  const home = await fixture(t);
  const panel = await linked(t, home, true);const model = await linked(t, home, false);
  const tool = (await panel.listTools()).tools.find(value => value.name === 'panel_usage');
  assert.deepEqual(tool._meta.ui.visibility, ['app']);
  assert.ok(!(await model.listTools()).tools.some(value => value.name === 'panel_usage'));
  const call = arguments_ => panel.callTool({ name: 'panel_usage', arguments: arguments_ });
  for (const input of [{}, { enabled: 'true' }, { enabled: true, endpoint: 'https://evil.example' }, { enabled: true, installation_id: 'secret' }]) {
    assert.equal((await call(input)).isError, true);
  }
  assert.equal((await usageStatus(home)).enabled, true, 'invalid app-only calls leave the default choice untouched');
  assert.equal((await call({ enabled: true })).structuredContent.enabled, true);
  assert.equal((await call({ enabled: false })).structuredContent.enabled, false);
  assert.ok(!(await readdir(home)).includes('usage-state.json'), 'saving preference alone never creates an ID');
});

test('shared backend reports without blocking tools; multiple connections deduplicate and opt-out aborts', async t => {
  const home = await fixture(t);await saveUsageSetting(home, true);
  let requests = 0;let aborted = false;let started;
  const ready = new Promise(resolve => { started = resolve; });
  const backend = await startBackend(home, { usageOptions: { version, fetchImpl: async (_url, init) => {
    requests++;started();
    return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => { aborted = true;reject(new Error('abort')); }, { once: true }));
  } } });
  const clients = [];
  t.after(async () => { for (const client of clients) await client.close();await backend.close(); });
  const connect = async path => {
    const client = new Client({ name: 'usage-backend-test', version: '1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(backend.url + path), { requestInit: { headers: await backendAuth(home) } }));
    clients.push(client);return client;
  };
  const [model, panel] = await Promise.all([connect('/mcp'), connect('/board')]);
  await ready;
  const inspected = await model.callTool({ name: 'work_inspect', arguments: {} });
  assert.equal(inspected.structuredContent.total, 0, 'tool completed while upload is unresolved');
  const snapshot = await panel.callTool({ name: 'panel_snapshot', arguments: {} });
  assert.equal(snapshot.structuredContent.usage.enabled, true);assert.equal(requests, 1);
  const off = await panel.callTool({ name: 'panel_usage', arguments: { enabled: false } });
  assert.equal(off.structuredContent.enabled, false);
  await delay(5);assert.equal(aborted, true);assert.equal(requests, 1);
});

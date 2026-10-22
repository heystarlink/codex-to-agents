import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ensureBackend, stopBackend, backendAuth, backendStatus } from '../src/backend-control.mjs';
import { lazyHermes } from '../src/hermes-loader.mjs';
import { OrderBook } from '../src/orders.mjs';

async function fixture(t) {
  const home = await mkdtemp('/tmp/cta-backend-');
  t.after(async () => { await stopBackend(home);await rm(home, { recursive: true, force: true }); });
  return home;
}

test('concurrent startup and HTTP clients share one backend; connection close and restart retain idempotent orders', async t => {
  const home = await fixture(t);
  const started = await Promise.all(Array.from({ length: 6 }, () => ensureBackend(home)));
  assert.equal(new Set(started.map(value => value.pid)).size, 1);
  const address = started[0].url;
  const headers = await backendAuth(home);
  const clients = [];
  const connect = async path => {
    const client = new Client({ name: 'shared-http-test', version: '1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(address + path), { requestInit: { headers } }));
    clients.push(client);return client;
  };
  try {
    const [a, b, panel] = await Promise.all([connect('/mcp'), connect('/mcp'), connect('/board')]);
    assert.equal((await a.listTools()).tools.length, 6);assert.equal((await panel.listTools()).tools.length, 3);
    const payload = { order_id: randomUUID(), goal: 'offline shared work' };
    const submitted = await Promise.all([a, b].map(client => client.callTool({ name: 'work_submit', arguments: payload })));
    assert.deepEqual(submitted.map(value => value.structuredContent.reused).sort(), [false, true]);
    const snapshot = () => panel.callTool({ name: 'panel_snapshot', arguments: {} }).then(value => value.structuredContent);
    assert.equal((await snapshot()).service.pid, started[0].pid);
    assert.equal((await snapshot()).service.hermes_loaded, false);
    await panel.callTool({ name: 'panel_snapshot', arguments: { executor: 'dsh', refresh_models: true } });
    assert.equal((await backendStatus(home)).hermes_loaded, false);
    await panel.callTool({ name: 'panel_settings', arguments: { enabled: false, executor: 'dsh' } });
    assert.equal((await snapshot()).delegation.executor, 'dsh');
    await a.close();
    assert.equal((await backendStatus(home)).pid, started[0].pid);
    assert.equal((await b.callTool({ name: 'work_inspect', arguments: { order_id: payload.order_id } })).structuredContent.status, 'queued');
    await stopBackend(home);const restarted = await ensureBackend(home);
    assert.notEqual(restarted.pid, started[0].pid);assert.equal(restarted.url, address);
    const same = await b.callTool({ name: 'work_submit', arguments: payload });
    assert.equal(same.structuredContent.reused, true);assert.equal((await snapshot()).summary.total, 1);
  } finally { await Promise.all(clients.map(client => client.close())); }
});

test('shared backend rejects foreign origins and missing credentials; private token is absent from endpoint metadata', async t => {
  const home = await fixture(t);const backend = await ensureBackend(home);
  const headers = await backendAuth(home);
  assert.equal((await fetch(backend.url + '/health')).status, 403);
  assert.equal((await fetch(backend.url + '/health', { headers: { ...headers, Origin: 'https://example.org' } })).status, 403);
  const foreignHost = await new Promise((resolve, reject) => {
    const req = request(backend.url + '/health', { headers: { ...headers, Host: 'example.org' } }, res => { res.resume();resolve(res.statusCode); });
    req.on('error', reject);req.end();
  });
  assert.equal(foreignHost, 403);
  assert.equal((await fetch(backend.url + '/mcp', { headers })).status, 405);
  assert.equal((await stat(join(home, 'backend-auth.json'))).mode & 0o777, 0o600);
  assert.ok(!(await readFile(join(home, 'backend.json'), 'utf8')).includes(headers.Authorization.slice(7)));
});

test('Hermes loads only for unfinished Hermes work, while completed and DSH work leave it unloaded', async t => {
  const home = await fixture(t);const book = new OrderBook(home);await book.open();
  await writeFile(join(home, 'settings.json'), JSON.stringify({ hermes: { url: 'http://127.0.0.1:9120' } }));
  await book.submit('work_submit', { goal: 'DSH work' });
  const finished = await book.submit('work_submit', { executor: 'hermes', goal: 'finished Hermes work' });
  await book.transition(finished.order_id, 'completed');
  let started = 0;let closed = 0;
  const loader = lazyHermes(home, { load: async () => ({ startHermesWorker: () => { started++;return { async close() { closed++; } }; } }) });
  try {
    await loader.check();assert.equal(loader.state.loaded, false);assert.equal(started, 0);
    await book.submit('work_submit', { executor: 'hermes', goal: 'new Hermes work' });
    await loader.check();await loader.check();
    assert.equal(loader.state.loaded, true);assert.equal(started, 1);
  } finally { await loader.close(); }
  assert.equal(closed, 1);
});

test('a runtime query can initialize Hermes before the first order; settings changes replace or stop the consumer', async t => {
  const home = await fixture(t);
  const path = join(home, 'settings.json');
  await writeFile(path, JSON.stringify({ hermes: { url: 'http://127.0.0.1:9120' } }));
  const started = [];const closed = [];
  const loader = lazyHermes(home, { load: async () => ({ startHermesWorker: (_home, settings) => {
    started.push(settings.url);return { async close() { closed.push(settings.url); } };
  } }) });
  try {
    await loader.check();assert.equal(started.length, 0);
    await loader.check({ force: true });
    assert.deepEqual(started, ['http://127.0.0.1:9120']);
    await writeFile(path, JSON.stringify({ hermes: { url: 'http://127.0.0.1:9121' } }));
    await loader.check({ force: true });
    assert.deepEqual(started, ['http://127.0.0.1:9120', 'http://127.0.0.1:9121']);
    assert.deepEqual(closed, ['http://127.0.0.1:9120']);
    await writeFile(path, '{}');await loader.check();
    assert.deepEqual(closed, started);
  } finally { await loader.close(); }
  assert.deepEqual(closed, started);
});

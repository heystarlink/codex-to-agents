import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from './worker.mjs';

const ID = 'e22f8408-bec2-4b25-a032-55045b383717';
const OTHER_ID = '57312637-c81a-42ed-98f2-d46e3b88c0a1';
const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

function setup(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(schema);
  const DB = {
    prepare(sql) {
      const statement = {
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() { return sqlite.prepare(sql).get(...this.args) ?? null; },
        run() { return sqlite.prepare(sql).run(...this.args); },
      };
      return statement;
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const result = statements.map(statement => statement.run());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return { sqlite, env: { DB } };
}

function request(body = { installation_id: ID, version: '0.1.0' }, options = {}) {
  return new Request('https://stats.example/v1/usage', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body), ...options,
  });
}

test('health checks database without revealing identifiers', async t => {
  const { env } = setup(t);
  const response = await worker.fetch(new Request('https://stats.example/health'), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('schema is non-destructive and reentrant', async t => {
  const { sqlite, env } = setup(t);
  await worker.fetch(request(), env);
  sqlite.exec(schema);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM installations').get().n, 1);
});

test('same installation/day deduplicates and normalizes UUID case', async t => {
  const { sqlite, env } = setup(t);
  assert.equal((await worker.fetch(request(), env)).status, 200);
  assert.equal((await worker.fetch(request({ installation_id: ID.toUpperCase(), version: '0.2.0' }), env)).status, 200);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM installations').get().n, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM daily_activity').get().n, 1);
  assert.equal(sqlite.prepare('SELECT installation_id, version FROM daily_activity').get().installation_id, ID);
  assert.equal(sqlite.prepare('SELECT latest_version FROM installations').get().latest_version, '0.2.0');
});

test('UTC day boundaries and multiple installations produce correct counts', async t => {
  const { sqlite, env } = setup(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-22T23:59:59Z') });
  await worker.fetch(request(), env);
  t.mock.timers.setTime(Date.parse('2026-10-23T00:00:00Z'));
  await worker.fetch(request(), env);
  await worker.fetch(request({ installation_id: OTHER_ID, version: '0.1.0' }), env);
  const days = sqlite.prepare('SELECT activity_day, COUNT(*) AS n FROM daily_activity GROUP BY activity_day ORDER BY activity_day').all();
  assert.deepEqual(days.map(row => ({ ...row })), [
    { activity_day: '2026-10-22', n: 1 }, { activity_day: '2026-10-23', n: 2 },
  ]);
  const install = sqlite.prepare('SELECT first_day, last_day FROM installations WHERE installation_id = ?').get(ID);
  assert.deepEqual({ ...install }, { first_day: '2026-10-22', last_day: '2026-10-23' });
});

test('invalid payloads never create rows', async t => {
  const { sqlite, env } = setup(t);
  for (const payload of [null, [], {}, { installation_id: ID },
    { installation_id: 'not-a-uuid', version: '0.1.0' },
    { installation_id: ID, version: 1 }, { installation_id: ID, version: '../private' },
    { installation_id: ID, version: '0.1.0-' + 'x'.repeat(65) },
    { installation_id: ID, version: '0.1.0', path: '/private/project' },
    { installation_id: ID, version: '0.1.0', date: '1990-01-01' }, '{bad json']) {
    assert.equal((await worker.fetch(request(payload), env)).status, 400);
  }
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM installations').get().n, 0);
});

test('rejects non-JSON but accepts JSON with charset', async t => {
  const { env } = setup(t);
  assert.equal((await worker.fetch(request('{}', { headers: { 'content-type': 'text/plain' } }), env)).status, 415);
  assert.equal((await worker.fetch(request(undefined, { headers: { 'content-type': 'application/json; charset=utf-8' } }), env)).status, 200);
});

test('enforces actual body bytes without trusting content-length', async t => {
  const { env, sqlite } = setup(t);
  const padded = JSON.stringify({ installation_id: ID, version: '0.1.0' }) + ' '.repeat(1100);
  const bytes = new TextEncoder().encode(padded);
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(bytes.slice(0, 600)); controller.enqueue(bytes.slice(600)); controller.close();
  } });
  const response = await worker.fetch(request('', {
    body: stream, duplex: 'half', headers: { 'content-type': 'application/json', 'content-length': '2' },
  }), env);
  assert.equal(response.status, 413);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM installations').get().n, 0);
});

test('body limit is in bytes and rejects oversized declared length', async t => {
  const { env } = setup(t);
  const valid = JSON.stringify({ installation_id: ID, version: '0.1.0' });
  assert.equal((await worker.fetch(request(valid.padEnd(1024, ' ')), env)).status, 200);
  assert.equal((await worker.fetch(request('{}'.padEnd(1024, ' ')), env)).status, 400);
  assert.equal((await worker.fetch(request('{}'.padEnd(1025, ' ')), env)).status, 413);
  assert.equal((await worker.fetch(request('{}', { headers: { 'content-type': 'application/json', 'content-length': '1025' } }), env)).status, 413);
});

test('invalid UTF-8 and failed streams are rejected without saving', async t => {
  const { env } = setup(t);
  assert.equal((await worker.fetch(request('', { body: new Uint8Array([0xff]) }), env)).status, 400);
  const body = new ReadableStream({ start(controller) { controller.error(new Error('private error')); } });
  assert.equal((await worker.fetch(request('', { body, duplex: 'half' }), env)).status, 400);
});

test('failed daily insert rolls back the installation registration', async t => {
  const { sqlite, env } = setup(t);
  sqlite.exec("CREATE TRIGGER abort_activity BEFORE INSERT ON daily_activity BEGIN SELECT RAISE(ABORT, 'private database error'); END");
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'temporarily_unavailable' });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM installations').get().n, 0);
});

test('database errors do not reveal secrets and missing binding fails closed', async () => {
  const env = { DB: { prepare() { throw new Error('private database path and token'); } } };
  const health = await worker.fetch(new Request('https://stats.example/health'), env);
  assert.equal(health.status, 503);
  assert.deepEqual(await health.json(), { ok: false });
  const usage = await worker.fetch(request(), {});
  assert.equal(usage.status, 503);
  assert.deepEqual(await usage.json(), { error: 'temporarily_unavailable' });
});

test('does not expose statistics or allow other methods', async () => {
  assert.equal((await worker.fetch(new Request('https://stats.example/stats'), {})).status, 404);
  const response = await worker.fetch(new Request('https://stats.example/v1/usage'), {});
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST');
  assert.equal((await worker.fetch(new Request('https://stats.example/health', { method: 'POST' }), {})).status, 405);
});

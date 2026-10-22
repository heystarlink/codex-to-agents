import { createServer } from 'node:http';
import { writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { backendAuth, readJson } from './backend-control.mjs';
import { lazyHermes } from './hermes-loader.mjs';

export async function startBackend(home) {
  home = resolve(home);
  const headers = await backendAuth(home);
  const lock = join(home, 'backend.lock');const instance = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await writeFile(lock, JSON.stringify({ pid: process.pid, instance }), { mode: 0o600, flag: 'wx' });break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await readJson(lock);
      try { process.kill(owner.pid, 0);throw Object.assign(new Error('Shared backend already running.'), { code: 'BACKEND_BUSY' }); }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      await unlink(lock);
      if (attempt) throw new Error('Could not acquire shared backend lock.');
    }
  }
  const worker = lazyHermes(home, { onError: error => console.error(error.message) });
  const previous = await readJson(join(home, 'backend.json'));
  let address;let closing;
  let cache;let cacheAt = 0;let reading;let readingGeneration;let generation = 0;
  const invalidate = () => { cache = null;cacheAt = 0;generation++; };
  const snapshot = async () => {
    if (cache && Date.now() - cacheAt < 1000) return cache;
    if (reading && readingGeneration === generation) return reading;
    const startedGeneration = generation;
    const pending = (async () => {
      const { monitorSnapshot } = await import('./monitor.mjs');
      const value = await monitorSnapshot(home);value.service.hermes_loaded = worker.state.loaded;
      if (startedGeneration === generation) {
        cache = value;cacheAt = Date.now();
      }
      return value;
    })();
    reading = pending;readingGeneration = startedGeneration;
    try { return await pending; } finally { if (reading === pending) reading = null; }
  };
  const token = Buffer.from(headers.Authorization);
  const server = createServer(async (req, res) => {
    const host = `127.0.0.1:${address?.port}`;
    const auth = Buffer.from(req.headers.authorization ?? '');
    if (req.headers.host !== host || req.headers.origin && req.headers.origin !== `http://${host}`
        || req.headers['sec-fetch-site'] === 'cross-site' || auth.length !== token.length || !timingSafeEqual(auth, token)) {
      res.writeHead(403).end('Local authorization required.');return;
    }
    res.setHeader('Cache-Control', 'no-store');res.setHeader('X-Content-Type-Options', 'nosniff');
    const path = new URL(req.url, `http://${host}`).pathname;
    try {
      if (path === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ pid: process.pid, home, instance, hermes_loaded: worker.state.loaded, external_owner_pid: worker.state.external_owner_pid }));return;
      }
      if (path === '/control/stop' && req.method === 'POST') {
        res.writeHead(200).end('{}');setImmediate(() => void close());return;
      }
      if (!['/mcp', '/board'].includes(path)) { res.writeHead(404).end();return; }
      if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end();return; }
      const [{ createMcp }, { StreamableHTTPServerTransport }] = await Promise.all([
        import('./mcp.mjs'), import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
      ]);
      const mcp = await createMcp(home, { panelOnly: path === '/board', snapshot, onSettings: invalidate,
        onRuntime: async executor => {
          if (executor !== 'dsh') {
            await worker.check({ force: true });invalidate();
          }
        },
        onOrder: () => { invalidate();worker.check(); } });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { void transport.close();void mcp.close(); });
      await mcp.connect(transport);await transport.handleRequest(req, res);
    } catch (error) {
      console.error(error.message);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agents backend request failed.' }));
    }
  });
  server.requestTimeout = 10000;server.headersTimeout = 5000;
  const close = () => closing ??= (async () => {
    await worker.close();
    await new Promise(resolve => { server.close(resolve);server.closeIdleConnections(); });
    const owner = await readJson(lock);
    if (owner?.instance === instance) await unlink(lock);
  })();
  try {
    await new Promise((resolve, reject) => { server.once('error', reject);server.listen(previous?.port ?? 0, '127.0.0.1', () => { server.off('error', reject);resolve(); }); });
    address = server.address();
    const value = { pid: process.pid, port: address.port, url: `http://127.0.0.1:${address.port}`, instance, started_at: new Date().toISOString() };
    const temporary = join(home, `backend.${instance}.tmp`);
    const { rename } = await import('node:fs/promises');
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });await rename(temporary, join(home, 'backend.json'));
    return { ...value, close, worker };
  } catch (error) { await worker.close();await unlink(lock);throw error; }
}

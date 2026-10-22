import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { monitorSnapshot } from './monitor.mjs';

export async function monitorWeb(home, { port = 18862, limit = 50 } = {}) {
  const [html, client, sdd] = await Promise.all([
    readFile(new URL('./monitor.html', import.meta.url)),
    readFile(new URL('./monitor-client.js', import.meta.url)),
    readFile(new URL('./sdd-client.js', import.meta.url)),
  ]);
  let address;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
    const host = req.headers.host;
    const allowed = [`127.0.0.1:${address?.port}`, `localhost:${address?.port}`];
    if (!allowed.includes(host) || req.headers['sec-fetch-site'] === 'cross-site'
        || req.headers.origin && !allowed.map(name => `http://${name}`).includes(req.headers.origin)) {
      res.writeHead(403).end('Local access only.');return;
    }
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }).end('Read-only monitor.');return; }
    try {
      const path = new URL(req.url, `http://${host}`).pathname;
      if (path === '/') res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
      else if (path === '/monitor-client.js') res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end(client);
      else if (path === '/sdd-client.js') res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end(sdd);
      else if (path === '/api/snapshot') {
        const snapshot = await monitorSnapshot(home, { limit });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(snapshot));
      } else res.writeHead(404).end('Not found.');
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  server.requestTimeout = 10000;server.headersTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject);resolve(); });
  });
  address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());server.closeIdleConnections();
      });
    },
  };
}

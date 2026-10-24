import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OrderBook } from '../src/orders.mjs';
import { createRecentOrderReader } from '../src/recent-orders.mjs';

// Keep filesystem instrumentation in a child so other concurrent tests keep
// their real imports and watchers. Both modes use the actual MCP tool surface.
async function probe(mode) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const source = `
    import fs from 'node:fs';
    import fsp from 'node:fs/promises';
    import { syncBuiltinESMExports, createRequire } from 'node:module';
    import { join } from 'node:path';
    import { tmpdir } from 'node:os';
    import { spawnSync } from 'node:child_process';
    import { setTimeout as delay } from 'node:timers/promises';
    const root = ${JSON.stringify(root)};
    const require = createRequire(join(root, 'package.json'));
    const nativeRead = fsp.readFile;
    const nativeWatch = fs.watch;
    const handles = new Set();
    let reads = 0;let blockedReads = 0;let home;let blocked;
    fs.watch = (...args) => {
      const handle = nativeWatch(...args);handles.add(handle);
      handle.once('close', () => handles.delete(handle));return handle;
    };
    fsp.readFile = async (file, ...args) => {
      const name = String(file);
      if (home && ['requests', 'states'].some(part => name.startsWith(join(home, part) + '/'))) reads++;
      if (name === blocked) { blockedReads++;throw Object.assign(new Error('unrelated history unavailable'), { code: 'EIO' }); }
      return nativeRead(file, ...args);
    };
    syncBuiltinESMExports();
    const { OrderBook } = await import(join(root, 'src/orders.mjs'));
    const { createMcp } = await import(join(root, 'src/mcp.mjs'));
    const { startBackend } = await import(join(root, 'src/backend.mjs'));
    const { backendAuth } = await import(join(root, 'src/backend-control.mjs'));
    const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
    const { InMemoryTransport } = await import(require.resolve('@modelcontextprotocol/sdk/inMemory.js'));
    const { StreamableHTTPClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'));
    home = await fsp.mkdtemp(join(tmpdir(), 'cta-recent-'));
    const book = new OrderBook(home);await book.open();
    let server;let backend;const clients = [];
    try {
      for (let start = 0; start < 1000; start += 25) {
        await Promise.all(Array.from({ length: 25 }, async (_, offset) => {
          const i = start + offset;
          const id = '00000000-0000-4000-8000-' + String(i).padStart(12, '0');
          await fsp.writeFile(join(home, 'requests', id + '.json'), JSON.stringify({ id, kind: 'work_submit', created_at: new Date(1760000000000 + i * 1000).toISOString(), payload: { executor: 'dsh', goal: 'old body' } }));
          await fsp.writeFile(join(home, 'states', id + '.json'), JSON.stringify({ status: 'completed', conversation_id: 'cw-' + i, progress: 'p'.repeat(300), output: { text: 'o'.repeat(20000) }, events: [] }));
        }));
      }
      const client = new Client({ name: 'recent-order-probe', version: '1' });clients.push(client);
      if (${JSON.stringify(mode)} === 'backend') {
        backend = await startBackend(home);const headers = await backendAuth(home);
        await client.connect(new StreamableHTTPClientTransport(new URL(backend.url + '/mcp'), { requestInit: { headers } }));
        // Opening the settings surface itself must still have no history index.
        const panel = new Client({ name: 'settings-probe', version: '1' });clients.push(panel);
        await panel.connect(new StreamableHTTPClientTransport(new URL(backend.url + '/board'), { requestInit: { headers } }));
        reads = 0;await panel.callTool({ name: 'panel_snapshot', arguments: {} });
        if (reads !== 0 || handles.size !== 0) throw new Error('settings acquired work-order history');
      } else {
        server = await createMcp(home);
        const [a, b] = InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
      }
      const list = async () => (await client.callTool({ name: 'work_inspect', arguments: { limit: 10 } })).structuredContent ?? { total: -1, orders: [] };
      reads = 0;const coldStart = performance.now();
      await list(); // A cold restore may read metadata for the entire history once.
      const coldReads = reads;const coldMs = +(performance.now() - coldStart).toFixed(1);
      reads = 0;
      const warm = await list();const warmReads = reads;
      blocked = join(home, 'states', '00000000-0000-4000-8000-000000000000.json');
      const withoutOld = await list();
      const newId = 'ffffffff-0000-4000-8000-000000000001';
      const child = spawnSync(process.execPath, ['--input-type=module', '-e',
        'import { writeFileSync } from "node:fs";' +
        'writeFileSync(' + JSON.stringify(join(home, 'requests', newId + '.json')) + ',' + JSON.stringify(JSON.stringify({ id: newId, kind: 'work_submit', created_at: '2099-01-01T00:00:00.000Z', payload: { executor: 'dsh', goal: 'new external task' } })) + ');' +
        'writeFileSync(' + JSON.stringify(join(home, 'states', newId + '.json')) + ',' + JSON.stringify(JSON.stringify({ status: 'completed', progress: 'external result', events: [] })) + ');'
      ], { encoding: 'utf8' });
      if (child.status !== 0) throw new Error(child.stderr);
      const changed = await list();
      const presentHandles = handles.size;
      for (const item of clients) await item.close();
      await delay(50);const handlesAfterPeerClose = handles.size;
      await server?.close();await backend?.close();
      await delay(50);
      console.log(JSON.stringify({ coldReads, coldMs, warmReads, total: warm.total, length: warm.orders.length,
        latest: warm.orders[0].order_id, progressLength: warm.orders[0].progress.length,
        oldUnavailableTotal: withoutOld.total, blockedReads, changedTotal: changed.total,
        changedLatest: changed.orders[0]?.order_id, presentHandles, handlesAfterPeerClose, remainingHandles: handles.size }));
    } finally {
      blocked = null;
      for (const item of clients) await item.close().catch(() => {});
      await server?.close();await backend?.close();
      for (const handle of handles) handle.close();
      await fsp.rm(home, { recursive: true, force: true });
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject);child.once('close', resolve); });
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout.trim());
}

for (const mode of ['standalone', 'backend']) {
  test(`${mode}: recent inspection reads its page, sees external publication and releases its index`, async t => {
    const result = await probe(mode);
    t.diagnostic(JSON.stringify(result));
    assert.ok(result.warmReads <= 20, `recent 10 must not re-read all 1000 bodies: ${JSON.stringify(result)}`);
    assert.equal(result.total, 1000);assert.equal(result.length, 10);
    assert.equal(result.latest, '00000000-0000-4000-8000-000000000999');
    assert.equal(result.progressLength, 250);
    assert.equal(result.oldUnavailableTotal, 1000);assert.equal(result.blockedReads, 0);
    assert.equal(result.changedTotal, 1001);assert.equal(result.changedLatest, 'ffffffff-0000-4000-8000-000000000001');
    assert.equal(result.presentHandles, 2);assert.equal(result.remainingHandles, 0);
    assert.equal(result.handlesAfterPeerClose, mode === 'backend' ? 2 : 0);
  });
}

test('a failed recent-index open can retry and closing a reader prevents new acquisitions', async t => {
  const home = await mkdtemp('/tmp/cta-recent-retry-');
  const reader = createRecentOrderReader(home);
  t.after(async () => { await reader.close();await rm(home, { recursive: true, force: true }); });
  await writeFile(join(home, 'requests'), 'not a directory');
  await assert.rejects(reader.list(10), { code: 'ENOTDIR' });
  await rm(join(home, 'requests'));await mkdir(join(home, 'requests'));
  const book = new OrderBook(home);
  const order = await book.submit('work_submit', { goal: 'recovered' });
  const page = await reader.list(10);
  assert.equal(page.total, 1);assert.equal(page.orders[0].order_id, order.order_id);
  await reader.close();await reader.close();
  await assert.rejects(reader.list(10), /closed/);
});

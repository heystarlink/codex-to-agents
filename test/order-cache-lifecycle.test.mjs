import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// Probe real watcher handles in a child: replacing fs.watch in the test process
// would otherwise affect other tests and the shared index registry.
async function probe(mode) {
  const cacheUrl = new URL('../src/order-cache.mjs', import.meta.url).href;
  const monitorUrl = new URL('../src/monitor-web.mjs', import.meta.url).href;
  const source = `
    import fs from 'node:fs';
    import fsp from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { createServer } from 'node:http';
    import { join } from 'node:path';
    import { tmpdir } from 'node:os';
    import { setTimeout as delay } from 'node:timers/promises';
    const active = new Set();
    const watch = fs.watch;
    fs.watch = (...args) => {
      const handle = watch(...args);
      active.add(handle);
      handle.once('close', () => active.delete(handle));
      return handle;
    };
    syncBuiltinESMExports();
    const { OrderIndex } = await import(${JSON.stringify(cacheUrl)});
    const { monitorWeb } = await import(${JSON.stringify(monitorUrl)});
    const home = await fsp.mkdtemp(join(tmpdir(), 'cta-watch-lifecycle-'));
    await fsp.mkdir(join(home, 'requests'));
    await fsp.mkdir(join(home, 'states'));
    let index;
    let busy;
    try {
      if (${JSON.stringify(mode)} === 'opening-race') {
        const id = 'cdf349b1-cee0-44bb-b8bb-e41ad0832e7d';
        const file = join(home, 'requests', id + '.json');
        await fsp.writeFile(file, JSON.stringify({ id, kind: 'work_submit', created_at: new Date().toISOString(), payload: { goal: 'startup race' } }));
        await fsp.writeFile(join(home, 'states', id + '.json'), JSON.stringify({ status: 'completed' }));
        let reads = 0;
        let enter;
        let release;
        const entered = new Promise(resolve => { enter = resolve; });
        const blocked = new Promise(resolve => { release = resolve; });
        const readFile = fsp.readFile;
        fsp.readFile = async (path, ...args) => {
          if (String(path) === file) {
            reads++;
            if (reads === 1) { enter();await blocked; }
          }
          return readFile(path, ...args);
        };
        syncBuiltinESMExports();
        index = new OrderIndex(home);
        // This case drives the overlap explicitly, independent of OS event timing.
        index.openWatchers = async () => {};
        const opening = index.open();
        await entered;
        const overlapping = index.sync();
        await delay(20);
        release();
        await Promise.all([opening, overlapping]);
        console.log(JSON.stringify({ reads, entries: index.all().length }));
      } else if (${JSON.stringify(mode)} === 'replacement') {
        index = new OrderIndex(home, { fallbackInterval: 50 });
        await index.open();
        await fsp.rename(join(home, 'states'), join(home, 'states.old'));
        await fsp.mkdir(join(home, 'states'));
        await index.sync();
        await delay(250);
        const during = active.size;
        await index.close();
        await delay(50);
        console.log(JSON.stringify({ during, after: active.size }));
      } else {
        busy = createServer();
        await new Promise(resolve => busy.listen(0, '127.0.0.1', resolve));
        let code;
        try {
          await monitorWeb(home, { port: busy.address().port });
        } catch (error) {
          code = error.code;
        }
        await delay(50);
        console.log(JSON.stringify({ code, after: active.size }));
      }
    } finally {
      await index?.close();
      for (const handle of active) { handle.close(); }
      if (busy) { await new Promise(resolve => busy.close(resolve)); }
      await fsp.rm(home, { recursive: true, force: true });
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout.trim());
}

test('replacing a watched directory retains its new watcher and releases every handle on close', async () => {
  assert.deepEqual(await probe('replacement'), { during: 2, after: 0 });
});

test('a monitor that fails to bind its port releases its acquired order index', async () => {
  assert.deepEqual(await probe('occupied-port'), { code: 'EADDRINUSE', after: 0 });
});

test('a sync requested during initial recovery joins the existing read', async () => {
  assert.deepEqual(await probe('opening-race'), { reads: 1, entries: 1 });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extensionBlock, stripExtension, install, prepareDshExtension } from '../src/command.mjs';
import { definitions, OrderBook } from '../src/orders.mjs';
import { createQoderFixture } from './fixtures/qoder-cli-fixture.mjs';

test('reinstall removes only its extension and preserves provider patches Cordis saved inside the markers', () => {
  const own = extensionBlock({ home: '/data', defaultDirectory: '/work', providers: ['*'] });
  const custom = '- id: llm-custom\n  name: custom-provider\n  config:\n    models: [custom-model]\n';
  const original = '- id: existing\n  config: {}\n' + own.replace('# END CODEX TO AGENTS', custom + '# END CODEX TO AGENTS');
  const kept = stripExtension(original);
  assert.ok(kept.includes(custom));assert.ok(kept.includes('- id: existing'));
  assert.ok(!kept.includes('codex-to-agents-desktop'));assert.ok(!kept.includes('CODEX TO AGENTS'));
  assert.equal((kept + own).match(/id: codex-to-agents-desktop/g).length, 1);
});

test('other plugins sharing an insert operation survive removal, including CRLF and wrapped module paths', () => {
  const original = '# BEGIN CODEX TO AGENTS\r\n- insert:\r\n    - id: "codex-to-agents-desktop"\r\n      name: "wrapped\\\r\n        module"\r\n      config: {}\r\n    - id: other-plugin\r\n      config:\r\n        enabled: true\r\n- id: third-plugin\r\n  config: {}\r\n# END CODEX TO AGENTS\r\n';
  const kept = stripExtension(original);
  assert.ok(!kept.includes('codex-to-agents-desktop'));
  assert.ok(kept.includes('- insert:\r\n    - id: other-plugin\r\n'));
  assert.ok(kept.includes('- id: third-plugin\r\n'));
});

test('marker validation rejects ambiguous blocks and leaves unmarked patches intact', () => {
  const plain = '- id: user-plugin\n  config: {}\n';assert.equal(stripExtension(plain), plain);
  assert.throws(() => stripExtension('# BEGIN CODEX TO AGENTS\n'), /Malformed/);
  assert.throws(() => stripExtension('# BEGIN CODEX TO AGENTS\n# BEGIN CODEX TO AGENTS\n# END CODEX TO AGENTS\n'), /Malformed/);
  assert.equal(stripExtension(extensionBlock({ home: '/data', defaultDirectory: '/work', providers: ['account'] })).trim(), '');
});

test('DSH setup rejects mixing all-provider mode with explicit IDs without changing the profile', async t => {
  const root = await mkdtemp('/tmp/cta-command-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = join(root, 'profiles/desktop');await mkdir(profile, { recursive: true });
  const path = join(profile, 'cordis.patch.yml');const original = '- id: user-plugin\n  config: {}\n';
  await writeFile(path, original);
  await assert.rejects(install({ home: join(root, 'data'), dshHome: root, provider: '*,account' }), /do not mix/);
  assert.equal(await readFile(path, 'utf8'), original);
});

test('the DSH runtime snapshot keeps the complete local import closure and still loads', async () => {
  // The installed Cordis plugin only sees the files prepareDshExtension copies.
  // If desktop.mjs (or a sibling in that set) starts importing another repo
  // module, this snapshot import must fail instead of leaving DSH with a
  // half-copied plugin. The permission adapter deliberately uses node: builtins
  // so adding this feature did not require widening the snapshot list.
  const extensionPath = await prepareDshExtension();
  const runtime = dirname(extensionPath);
  const copied = (await readdir(runtime)).sort();
  assert.ok(copied.includes('extension.mjs'));
  assert.ok(copied.includes('desktop.mjs'));
  assert.ok(copied.includes('worker.mjs'));
  assert.ok(copied.includes('orders.mjs'));
  // The shared executor registry is imported by worker/orders, so the installed
  // snapshot must carry it too.
  assert.ok(copied.includes('executors.mjs'));
  // Resolve every relative import of every copied module and require its target
  // to exist in the snapshot itself.
  for (const name of copied.filter(file => file.endsWith('.mjs'))) {
    const source = await readFile(join(runtime, name), 'utf8');
    for (const match of source.matchAll(/from\s+['"](\.\.?\/[^'"]+)['"]/g)) {
      assert.ok(copied.includes(match[1].split('/').at(-1)), `${name} imports ${match[1]}, which the snapshot must copy`);
    }
  }
  // A real dynamic import proves Node can resolve the whole graph from .local
  // (zod included) without the repo's other modules.
  const loaded = await import(`${pathToFileURL(extensionPath).href}?closure=${Date.now()}`);
  assert.equal(loaded.name, 'codex-to-agents-desktop');
  assert.deepEqual(loaded.inject, ['llm', 'agentDefaultModel', 'agents', 'sessionController', 'sessionQuery', 'workspaceRegistry', 'workspaceController']);
  assert.equal(typeof loaded.apply, 'function');
});

test('Qoder enable verifies the executable, stores discovery results and keeps history on disable', async t => {
  const root = await mkdtemp('/tmp/cta-qoder-command-');
  const previousHome = process.env.HOME;
  process.env.HOME = join(root, 'home');
  await mkdir(join(root, 'home', '.codex'), { recursive: true });
  t.after(async () => { process.env.HOME = previousHome;await rm(root, { recursive: true, force: true }); });
  const cli = await createQoderFixture(t);
  const home = join(root, 'data');
  const registered = [];
  const register = async value => { registered.push(value); };
  const enabled = await install({
    home, executor: 'qoder', action: 'enable',
    'qoder-executable': cli.executable, directory: join(root, 'work'),
  }, { register });
  assert.equal(enabled.configured, true);
  assert.equal(enabled.executor, 'qoder');
  assert.equal(enabled.executable, cli.executable);
  assert.equal(enabled.version, cli.version);
  assert.equal(enabled.login_required, true);
  assert.deepEqual(registered, [home]);
  const saved = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'));
  assert.equal(saved.qoder.executable, cli.executable);
  assert.equal(saved.qoder.version, cli.version);
  assert.equal(saved.qoder.defaultDirectory, join(root, 'work'));
  await access(saved.qoder.defaultDirectory);
  assert.ok((await readdir(join(home, 'backups'))).length >= 1);

  const book = new OrderBook(home);await book.open();
  const order = await book.submit('work_submit', { executor: 'qoder', goal: 'retain history' });
  const disabled = await install({ home, executor: 'qoder', action: 'disable' }, { register });
  assert.equal(disabled.configured, false);
  assert.equal('qoder' in JSON.parse(await readFile(join(home, 'settings.json'), 'utf8')), false);
  assert.equal((await book.inspect(order.order_id)).executor, 'qoder');
  assert.equal(registered.length, 1, 'disable does not register MCP again');
});

test('Qoder enable rejects an unverified executable without writing settings', async t => {
  const root = await mkdtemp('/tmp/cta-qoder-command-bad-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'data');
  await assert.rejects(
    install({ home, executor: 'qoder', action: 'enable', 'qoder-executable': '/nonexistent/qodercli' }, { register: async () => {} }),
    error => error.code === 'QODER_NOT_FOUND',
  );
  await assert.rejects(access(join(home, 'settings.json')), { code: 'ENOENT' });
});

test('model-facing work orders cannot persist any new-session permission preference', () => {
  // Only the app-only board tool writes delegation.json; work_submit and
  // work_update stay strictly closed so a model cannot raise its own permission
  // for any executor.
  const submit = { executor: 'dsh', goal: 'Do the work.' };
  assert.equal(definitions.work_submit.schema.safeParse(submit).success, true);
  for (const field of ['dsh_permission', 'hermes_permission', 'qoder_permission']) {
    assert.equal(definitions.work_submit.schema.safeParse({ ...submit, [field]: 'read-only' }).success, false, `${field} must not be model-settable`);
  }
  const update = { target_order: '6f1c5bd8-7b3f-4d02-8f6e-8b2f4a5c9d10', action: 'append', message: 'continue' };
  assert.equal(definitions.work_update.schema.safeParse(update).success, true);
  for (const field of ['dsh_permission', 'hermes_permission', 'qoder_permission']) {
    assert.equal(definitions.work_update.schema.safeParse({ ...update, [field]: 'yolo' }).success, false, `${field} must not be model-settable`);
  }
});

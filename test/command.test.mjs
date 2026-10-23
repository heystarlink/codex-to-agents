import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extensionBlock, stripExtension, install, prepareDshExtension } from '../src/command.mjs';
import { definitions } from '../src/orders.mjs';

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

test('model-facing work orders cannot persist the DSH-only permission preference', () => {
  // Only the app-only board tool writes delegation.json; work_submit and
  // work_update stay strictly closed so a model cannot raise its own permission.
  const submit = { executor: 'dsh', goal: 'Do the work.' };
  assert.equal(definitions.work_submit.schema.safeParse(submit).success, true);
  assert.equal(definitions.work_submit.schema.safeParse({ ...submit, dsh_permission: 'danger-full-access' }).success, false);
  const update = { target_order: '6f1c5bd8-7b3f-4d02-8f6e-8b2f4a5c9d10', action: 'append', message: 'continue' };
  assert.equal(definitions.work_update.schema.safeParse(update).success, true);
  assert.equal(definitions.work_update.schema.safeParse({ ...update, dsh_permission: 'read-only' }).success, false);
});

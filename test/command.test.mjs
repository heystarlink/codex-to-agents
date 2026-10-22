import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { extensionBlock, stripExtension, install } from '../src/command.mjs';

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

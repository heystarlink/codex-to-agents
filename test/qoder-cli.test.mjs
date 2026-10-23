import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { createQoderFixture, QODER_FIXTURE_VERSION } from './fixtures/qoder-cli-fixture.mjs';
import {
  listModelsError, parseModelList, parsePermissionModes, probeExecutable, qoderCandidates, readPermissionModes,
  resolveEffort, resolveExecutable, runCli,
} from '../src/qoder-cli.mjs';

// The exact real 1.1.78 catalogue captured from the installed CLI. The parser
// must accept this shape and only this shape for text output.
const REAL_CATALOG = [
  'MODEL', 'Auto', 'Ultimate', 'Fast', 'Efficient', 'Sonus', 'Cantus', 'Qwen3.8-Max',
  'Qwen3.8-Flash', 'Kimi-K3', 'Kimi-K2.8-Preview', 'GLM-5.3', 'GLM-5.3-Flash',
  'DeepSeek-V4-Pro', 'DeepSeek-Flash', 'MiniMax-M3.1-Flash',
].join('\n') + '\n';

test('parses the real single-column MODEL catalogue without inventing models', () => {
  const models = parseModelList(REAL_CATALOG);
  assert.deepEqual(models.map(model => model.model), [
    'Auto', 'Ultimate', 'Fast', 'Efficient', 'Sonus', 'Cantus', 'Qwen3.8-Max',
    'Qwen3.8-Flash', 'Kimi-K3', 'Kimi-K2.8-Preview', 'GLM-5.3', 'GLM-5.3-Flash',
    'DeepSeek-V4-Pro', 'DeepSeek-Flash', 'MiniMax-M3.1-Flash',
  ]);
  for (const model of models) {
    assert.equal(model.provider, 'qoder');
    assert.deepEqual(model.efforts, []);
  }
});

test('accepts structured JSON catalogues with declared efforts but rejects ambiguous text', () => {
  const json = JSON.stringify([
    { id: 'Auto', name: 'Auto', efforts: ['low', 'high'] },
    { id: 'DeepSeek-V4-Pro', name: 'DeepSeek V4 Pro' },
  ]);
  const models = parseModelList(json);
  assert.deepEqual(models.map(model => [model.model, model.efforts]), [['Auto', ['low', 'high']], ['DeepSeek-V4-Pro', []]]);

  assert.throws(() => parseModelList('MODEL\n'), /没有可用的模型名称/);
  assert.throws(() => parseModelList('Available models:\nWarning: model catalog unavailable\n'), /缺少 MODEL 表头/);
  assert.throws(() => parseModelList('Warning: model catalog is temporarily unavailable.\n'), /缺少 MODEL 表头/);
  assert.throws(() => parseModelList('MODEL\nAuto\nWarning: catalog partially unavailable\n'), /无法识别的非单列内容/);
  assert.throws(() => parseModelList(''), /没有输出/);
  assert.throws(() => parseModelList('MODEL\n<not a model>\n'), /没有可用的模型名称|无法识别/);
});

test('maps CLI failures to explicit catalog errors, especially missing login', () => {
  assert.match(listModelsError({ status: 1, stdout: '', stderr: 'Not logged in. Run `qodercli login` to authenticate.' }), /未登录/);
  assert.match(listModelsError({ status: 0, stdout: 'Warning: catalog unavailable', stderr: '' }), /失败（退出码 0）/);
  assert.match(listModelsError({ status: null, stdout: '', stderr: '', error: 'spawn ENOENT' }), /无法运行/);
  assert.match(listModelsError({ status: null, timedOut: true }), /超时/);
});

test('resolveEffort never invents a value and omits the default', () => {
  assert.equal(resolveEffort({ efforts: ['low', 'high'] }, undefined), null);
  assert.equal(resolveEffort({ efforts: ['low', 'high'] }, 'default'), null);
  assert.equal(resolveEffort({ efforts: ['low', 'high'] }, 'high'), 'high');
  assert.throws(() => resolveEffort({ efforts: [] }, 'high'), /未声明思考强度/);
  assert.throws(() => resolveEffort({ efforts: ['low'] }, 'xhigh'), /不可用/);
});

test('discovery verifies the configured executable and never silently substitutes it', async t => {
  const fixture = await createQoderFixture(t);
  const explicit = await resolveExecutable({ executable: fixture.executable });
  assert.equal(explicit.version, QODER_FIXTURE_VERSION);
  await assert.rejects(resolveExecutable({ executable: '/nonexistent/qodercli' }), error => error.code === 'QODER_NOT_FOUND');
  await assert.rejects(probeExecutable('relative/qodercli'), /绝对路径/);
  const discovered = await resolveExecutable({ pathEnv: dirname(fixture.executable), home: '/nonexistent' });
  assert.equal(discovered.executable, fixture.executable);
  assert.ok(qoderCandidates({ pathEnv: '/a:/b', home: '/Users/example' }).includes('/Users/example/.local/bin/qodercli'));
  fixture.setControl({ version: 'not-a-version' });
  await assert.rejects(probeExecutable(fixture.executable), /版本检查失败/);
});

test('catalog probes are asynchronous and bounded by a timeout', async t => {
  const fixture = await createQoderFixture(t, { control: { models_mode: 'hang', modelsHangMs: 5000 } });
  const started = Date.now();
  let timerFired = false;
  const timer = new Promise(resolve => setTimeout(() => { timerFired = true;resolve(); }, 150));
  const listing = await runCli(fixture.executable, ['--list-models'], { timeout: 400 });
  assert.equal(listing.timedOut, true);
  await timer;
  assert.equal(timerFired, true, 'a hung catalog probe must not block the event loop');
  assert.ok(Date.now() - started < 4000);
});


test('reads the real --permission-mode choices and never guesses an absent flag', async t => {
  // Exact 1.1.78 shape, including the wrapped choices continuation lines.
  const real = [
    'Options:',
    '  --permission-mode <mode>             Set the permission mode (choices:',
    '                                       default, accept_edits,',
    '                                       bypass_permissions, dont_ask, auto)',
    '  --dangerously-skip-permissions       Bypass all permission checks',
  ].join('\n');
  assert.deepEqual(parsePermissionModes(real),
    ['default', 'accept_edits', 'bypass_permissions', 'dont_ask', 'auto']);
  assert.equal(parsePermissionModes('Options:\n  -p, --print  Print and exit\n'), null);
  assert.equal(parsePermissionModes('Options:\n  --permission-mode <mode>  Set mode\n'), null);

  const fixture = await createQoderFixture(t);
  const probed = await readPermissionModes(fixture.executable);
  assert.equal(probed.available, true);
  // default is represented by omitting the flag on the board, so only explicit
  // modes are offered here.
  assert.deepEqual(probed.modes, ['accept_edits', 'dont_ask', 'auto', 'bypass_permissions']);

  // A help text without the option becomes an explicit unsupported capability,
  // not an empty guessed list.
  const legacy = await readPermissionModes(fixture.executable, {
    run: async () => ({ status: 0, stdout: 'Usage: qodercli [options]\n  -p, --print\n', stderr: '', error: null, timedOut: false }),
  });
  assert.deepEqual(legacy.modes, []);
  assert.equal(legacy.available, false);
  assert.match(legacy.reason, /未声明 --permission-mode/);
});

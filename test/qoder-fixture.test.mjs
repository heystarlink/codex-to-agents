/**
 * Self-tests for the isolated fake `qodercli` fixture.
 *
 * These assert the fixture contract itself (exit codes, JSONL shapes, control
 * switches, invocation/session logs) so the real adapter tests can trust it.
 * They never touch the network, the user's home directory or Qoder credentials.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  createQoderFixture,
  DEFAULT_QODER_MODELS,
  QODER_FIXTURE_VERSION,
  QODER_LOGIN_MESSAGE
} from './fixtures/qoder-cli-fixture.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STREAM_ARGS = ['-p', '--output-format', 'stream-json'];
const MODEL_NAMES = DEFAULT_QODER_MODELS.map(model => model.name);
const EXPECTED_MODEL_TEXT = `${['MODEL', ...MODEL_NAMES].join('\n')}\n`;

function parseJsonLines(stdout) {
  return stdout
    .split('\n')
    .filter(line => line.length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`stdout line ${index + 1} is not valid JSON: ${line.slice(0, 120)}`);
      }
    });
}

function findInit(messages) {
  const init = messages.find(message => message.type === 'system' && message.subtype === 'init');
  assert.ok(init, 'expected a system/init message');
  return init;
}

const sleep = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));

test('--version reports the real Qoder CLI version and records the invocation', async t => {
  const fixture = await createQoderFixture(t);
  const result = await fixture.run(['--version']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, `${QODER_FIXTURE_VERSION}\n`);
  assert.equal(result.stderr, '');
  assert.equal(fixture.executable.startsWith('/'), true);
  assert.equal(existsSync(fixture.executable), true);
  const records = await fixture.invocations();
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].argv, ['--version']);
  assert.equal(records[0].session_id, null);
  assert.equal(records[0].exit_code, 0);
  assert.equal(typeof records[0].ts, 'string');
  const idle = await fixture.waitForIdle();
  assert.equal(idle.count, 1);
});

test('--help only documents options the real CLI supports (never --max-turns)', async t => {
  const fixture = await createQoderFixture(t);
  const result = await fixture.run(['--help']);
  assert.equal(result.code, 0);
  for (const flag of ['-p', '--print', '--output-format', '--cwd', '--model', '--reasoning-effort', '--resume',
    '--session-id', '--list-models', '--version', '--permission-mode', '--allowed-tools', '--disallowed-tools',
    '--max-output-tokens', '--input-format']) {
    assert.ok(result.stdout.includes(flag), `help should document ${flag}`);
  }
  assert.equal(result.stdout.includes('--max-turns'), false);
});

test('--list-models text mode prints exactly the real MODEL catalogue, one name per line', async t => {
  const fixture = await createQoderFixture(t);
  const result = await fixture.run(['--list-models']);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, EXPECTED_MODEL_TEXT);
  const lines = result.stdout.split('\n');
  assert.equal(lines[0], 'MODEL');
  assert.deepEqual(lines.slice(1, -1), MODEL_NAMES);
  assert.equal(lines.some(line => line !== line.trim()), false, 'catalogue must be a single column with no padding');
  assert.equal(result.stdout.includes('  '), false);
});

test('--list-models json mode returns a parseable model array', async t => {
  const fixture = await createQoderFixture(t);
  await fixture.setControl({ models_mode: 'json' });
  const result = await fixture.run(['--list-models']);
  assert.equal(result.code, 0);
  const models = JSON.parse(result.stdout);
  assert.ok(Array.isArray(models));
  assert.deepEqual(models.map(model => model.id), MODEL_NAMES);
  assert.equal(models[0].id, 'Auto');
  assert.equal(models[0].default, true);
  assert.equal(models.filter(model => model.default).length, 1);
});

test('--list-models diagnostics mode exits 0 with warning/error text and no MODEL header', async t => {
  const fixture = await createQoderFixture(t);
  await fixture.setControl({ models_mode: 'diagnostics' });
  const result = await fixture.run(['--list-models']);
  assert.equal(result.code, 0);
  const combined = `${result.stdout}${result.stderr}`;
  assert.equal(combined.includes('MODEL'), false);
  for (const name of MODEL_NAMES) assert.equal(combined.includes(name), false, `diagnostics output must not list ${name}`);
  assert.match(combined, /warning/i);
  assert.match(combined, /error/i);
});

test('--list-models header_only mode exits 0 with only the MODEL header', async t => {
  const fixture = await createQoderFixture(t);
  await fixture.setControl({ models_mode: 'header_only' });
  const result = await fixture.run(['--list-models']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'MODEL\n');
  assert.equal(result.stderr, '');
});

test('--list-models hang mode stays silent for a long time and can be signalled off', async t => {
  const fixture = await createQoderFixture(t);
  await fixture.setControl({ models_mode: 'hang' });
  const handle = fixture.spawn(['--list-models']);
  t.after(() => {
    try {
      handle.child.kill('SIGKILL');
    } catch {
      // already exited
    }
  });
  // Wait until the child has recorded its invocation (which happens after its
  // signal handlers are installed), then signal it. A fixed sleep is racy on a
  // loaded machine and may hit the default SIGTERM disposition instead.
  const [invocation] = await fixture.waitForInvocations(1);
  assert.equal(invocation.models_mode, 'hang');
  assert.equal(handle.child.exitCode, null, 'a catalogue hang must not exit on its own within the probe window');
  assert.equal(handle.stdout(), '');
  handle.kill('SIGTERM');
  const { code, signal } = await handle.exited;
  assert.equal(signal, null);
  assert.equal(code, 143);
  assert.equal(handle.stdout(), '');
  const settledInvocation = (await fixture.invocations())[0];
  assert.equal(settledInvocation.exit_code, 143);
});

test('--list-models not_logged_in mode reports the exact login hint with exit code 1', async t => {
  const fixture = await createQoderFixture(t);
  await fixture.setControl({ models_mode: 'not_logged_in' });
  const result = await fixture.run(['--list-models']);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `${QODER_LOGIN_MESSAGE}\n`);
});

test('success stream-json emits hook/init/thinking/text/tool lines then a final success result', async t => {
  const fixture = await createQoderFixture(t);
  const prompt = 'Summarise the repository.\nSecond line with unicode ✓';
  const result = await fixture.run([...STREAM_ARGS, '--cwd', fixture.dir, '--model', 'Ultimate', '--reasoning-effort', 'high'], { stdin: prompt });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');

  const messages = parseJsonLines(result.stdout);
  const init = findInit(messages);
  const initIndex = messages.indexOf(init);
  const systemSubtypes = messages.filter(message => message.type === 'system').map(message => message.subtype);
  assert.ok(systemSubtypes.includes('hook_started'));
  assert.ok(systemSubtypes.includes('artifacts_update'));
  assert.ok(systemSubtypes.indexOf('hook_started') < initIndex);
  assert.ok(systemSubtypes.indexOf('artifacts_update') < initIndex);

  assert.match(init.session_id, UUID_PATTERN);
  assert.equal(init.cwd, fixture.dir);
  assert.equal(init.model, 'Ultimate');
  assert.equal(init.qodercli_version, QODER_FIXTURE_VERSION);
  assert.equal(init.permissionMode, 'default');

  const assistantMessages = messages.filter(message => message.type === 'assistant');
  const thinking = assistantMessages.find(message => message.message.content[0]?.type === 'thinking');
  const text = assistantMessages.find(message => message.message.content[0]?.type === 'text');
  assert.ok(thinking, 'expected a thinking assistant block');
  assert.ok(text, 'expected a text assistant block');
  assert.equal(thinking.message.id, text.message.id, 'thinking and answer must share one assistant message id');

  const promptEcho = `ECHO:${prompt.slice(0, 80)}`;
  assert.ok(text.message.content[0].text.includes(promptEcho));

  const toolUse = assistantMessages
    .flatMap(message => message.message.content)
    .find(block => block.type === 'tool_use');
  assert.ok(toolUse, 'expected a tool_use block');
  const toolResult = messages.find(message => message.type === 'user');
  assert.equal(toolResult.message.content[0].type, 'tool_result');
  assert.equal(toolResult.message.content[0].tool_use_id, toolUse.id);

  const final = messages.at(-1);
  assert.equal(final.type, 'result');
  assert.equal(final.subtype, 'success');
  assert.equal(final.is_error, false);
  assert.equal(final.session_id, init.session_id);
  assert.ok(final.result.includes(promptEcho));
  assert.equal(typeof final.num_turns, 'number');
  assert.ok(final.usage.input_tokens > 0);
  assert.ok(messages.indexOf(toolResult) < messages.indexOf(final));

  const [invocation] = await fixture.invocations();
  assert.equal(invocation.stdin, prompt);
  assert.equal(invocation.cwd, fixture.dir);
  assert.equal(invocation.model, 'Ultimate');
  assert.equal(invocation.reasoning_effort, 'high');
  assert.equal(invocation.exit_code, 0);
});

test('--output-format json and text return the same success result text', async t => {
  const fixture = await createQoderFixture(t);
  const jsonRun = await fixture.run(['-p', '--output-format', 'json'], { stdin: 'hello' });
  assert.equal(jsonRun.code, 0);
  const parsed = JSON.parse(jsonRun.stdout);
  assert.equal(parsed.type, 'result');
  assert.equal(parsed.subtype, 'success');
  assert.equal(parsed.is_error, false);
  assert.ok(parsed.result.endsWith('ECHO:hello'));

  const textRun = await fixture.run(['-p', '--output-format', 'text'], { stdin: 'hello' });
  assert.equal(textRun.code, 0);
  assert.equal(textRun.stdout, `${parsed.result}\n`);
});

test('--resume keeps the native session id and accumulates the conversation state', async t => {
  const fixture = await createQoderFixture(t);
  const first = await fixture.run(STREAM_ARGS, { stdin: 'first question' });
  const sessionId = findInit(parseJsonLines(first.stdout)).session_id;
  assert.match(sessionId, UUID_PATTERN);

  const second = await fixture.run([...STREAM_ARGS, '--resume', sessionId], { stdin: 'follow up marker' });
  assert.equal(second.code, 0);
  const secondMessages = parseJsonLines(second.stdout);
  assert.equal(findInit(secondMessages).session_id, sessionId);
  const final = secondMessages.at(-1);
  assert.equal(final.session_id, sessionId);
  assert.ok(final.result.includes('ECHO:follow up marker'));

  const session = await fixture.readSession(sessionId);
  assert.equal(session.id, sessionId);
  assert.deepEqual(session.calls.map(call => call.prompt), ['first question', 'follow up marker']);
  assert.equal(session.calls[1].resumed, true);
  const records = await fixture.invocations();
  assert.equal(records[1].resume, sessionId);
  assert.equal(records[1].session_id, sessionId);
});

test('--session-id fixes the id and resume_mismatch answers a stale resume with a different id', async t => {
  const fixture = await createQoderFixture(t);
  const fixed = '11111111-2222-4333-8444-555555555555';
  const fixedRun = await fixture.run([...STREAM_ARGS, '--session-id', fixed], { stdin: 'new session' });
  assert.equal(fixedRun.code, 0);
  assert.equal(findInit(parseJsonLines(fixedRun.stdout)).session_id, fixed);

  await fixture.setControl({ resume_mismatch: true });
  const mismatchRun = await fixture.run([...STREAM_ARGS, '--resume', fixed], { stdin: 'resumed' });
  assert.equal(mismatchRun.code, 0);
  const messages = parseJsonLines(mismatchRun.stdout);
  const init = findInit(messages);
  assert.notEqual(init.session_id, fixed);
  assert.match(init.session_id, UUID_PATTERN);
  assert.equal(messages.at(-1).session_id, init.session_id);

  const records = await fixture.invocations();
  const mismatchRecord = records.at(-1);
  assert.equal(mismatchRecord.requested_session_id, fixed);
  assert.equal(mismatchRecord.session_id, init.session_id);
});

test('error result subtypes surface as failures with their own exit codes', async t => {
  const fixture = await createQoderFixture(t);
  await fixture.setControl({ mode: 'error_during_execution' });
  const during = await fixture.run(STREAM_ARGS, { stdin: 'x' });
  assert.equal(during.code, 1);
  const duringMessages = parseJsonLines(during.stdout);
  const duringFinal = duringMessages.at(-1);
  assert.equal(duringFinal.type, 'result');
  assert.equal(duringFinal.subtype, 'error_during_execution');
  assert.equal(duringFinal.is_error, true);
  assert.ok(Array.isArray(duringFinal.errors) && duringFinal.errors.length > 0);
  assert.equal(findInit(duringMessages).session_id, duringFinal.session_id);

  await fixture.setControl({ mode: 'error_max_turns' });
  const maxTurns = await fixture.run(STREAM_ARGS, { stdin: 'x' });
  assert.equal(maxTurns.code, 53);
  const maxTurnsFinal = parseJsonLines(maxTurns.stdout).at(-1);
  assert.equal(maxTurnsFinal.subtype, 'error_max_turns');
  assert.equal(maxTurnsFinal.is_error, true);
});

test('a stream ending with assistant text and no result must not look like success', async t => {
  const fixture = await createQoderFixture(t);
  await fixture.setControl({ mode: 'exit_without_result' });
  const result = await fixture.run(STREAM_ARGS, { stdin: 'x' });
  assert.equal(result.code, 0);
  const messages = parseJsonLines(result.stdout);
  assert.ok(messages.some(message => message.type === 'assistant'));
  assert.equal(messages.some(message => message.type === 'result'), false);
});

test('protocol_garbage writes non-JSON lines after exit 0', async t => {
  const fixture = await createQoderFixture(t);
  await fixture.setControl({ mode: 'protocol_garbage' });
  const result = await fixture.run(STREAM_ARGS, { stdin: 'x' });
  assert.equal(result.code, 0);
  assert.ok(result.stdout.length > 0);
  const lines = result.stdout.split('\n').filter(line => line.length > 0);
  assert.ok(lines.length > 0);
  for (const line of lines) assert.throws(() => JSON.parse(line), /Unexpected|JSON/);
});

test('not_logged_in print mode exits 41 with the exact login hint on stderr', async t => {
  const fixture = await createQoderFixture(t);
  await fixture.setControl({ mode: 'not_logged_in' });
  const result = await fixture.run(STREAM_ARGS, { stdin: 'x' });
  assert.equal(result.code, 41);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `${QODER_LOGIN_MESSAGE}\n`);
});

test('burst writes init, assistant and success result in one tick and exits 0', async t => {
  const fixture = await createQoderFixture(t);
  await fixture.setControl({ burst: true });
  const prompt = 'burst marker';
  const result = await fixture.run([...STREAM_ARGS, '--model', 'Fast'], { stdin: prompt });
  assert.equal(result.code, 0);
  const messages = parseJsonLines(result.stdout);
  assert.deepEqual(messages.map(message => message.type), ['system', 'assistant', 'result']);
  assert.equal(messages[0].subtype, 'init');
  assert.match(messages[0].session_id, UUID_PATTERN);
  assert.equal(messages[0].model, 'Fast');
  assert.equal(messages[1].message.content[0].type, 'text');
  const final = messages[2];
  assert.equal(final.subtype, 'success');
  assert.equal(final.is_error, false);
  assert.equal(final.session_id, messages[0].session_id);
  assert.ok(final.result.includes(`ECHO:${prompt}`));
});

test('exit_after_result keeps a valid success result but changes the process exit code', async t => {
  const fixture = await createQoderFixture(t);
  await fixture.setControl({ exit_after_result: 1 });
  const result = await fixture.run(STREAM_ARGS, { stdin: 'x' });
  assert.equal(result.code, 1);
  const final = parseJsonLines(result.stdout).at(-1);
  assert.equal(final.type, 'result');
  assert.equal(final.subtype, 'success');
  assert.equal(final.is_error, false);
  let [invocation] = await fixture.invocations();
  assert.equal(invocation.exit_code, 1);

  await fixture.setControl({ exit_after_result: 0 });
  const clean = await fixture.run(STREAM_ARGS, { stdin: 'x' });
  assert.equal(clean.code, 0);
  const cleanInvocation = (await fixture.invocations()).at(-1);
  assert.equal(cleanInvocation.exit_code, 0);
});

test('signal_after_result ends a successful stream by signal', async t => {
  const fixture = await createQoderFixture(t);
  await fixture.setControl({ signal_after_result: 'SIGTERM' });
  const result = await fixture.run(STREAM_ARGS, { stdin: 'x' });
  assert.equal(result.code, null);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(parseJsonLines(result.stdout).at(-1).subtype, 'success');
});

test('long_line writes a >3MB line with no newline and never a result', async t => {
  const fixture = await createQoderFixture(t);
  const bytes = 3 * 1024 * 1024 + 64;
  await fixture.setControl({ mode: 'long_line', longLineBytes: bytes, longLineSleepMs: 150 });
  const result = await fixture.run(STREAM_ARGS, { stdin: 'x', timeoutMs: 15000 });
  assert.equal(result.code, 0);
  const lines = result.stdout.split('\n');
  assert.equal(lines.length, 2, 'expected exactly the init line and the unterminated giant line');
  const init = JSON.parse(lines[0]);
  assert.equal(init.type, 'system');
  assert.equal(init.subtype, 'init');
  assert.ok(lines[1].length >= bytes);
  assert.equal(lines[1], 'x'.repeat(lines[1].length));
  assert.equal(result.stdout.includes('"type":"result"'), false);
  assert.equal(result.stdout.endsWith('\n'), false);
});

test('result_without_init emits a success result first with no system/init', async t => {
  const fixture = await createQoderFixture(t);
  await fixture.setControl({ result_without_init: true });
  const result = await fixture.run(STREAM_ARGS, { stdin: 'x' });
  assert.equal(result.code, 0);
  const messages = parseJsonLines(result.stdout);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'result');
  assert.equal(messages[0].subtype, 'success');
  assert.equal(messages.some(message => message.type === 'system'), false);
});

test('a running print session can be cancelled with SIGINT and exits 130', async t => {
  const fixture = await createQoderFixture(t);
  await fixture.setControl({ mode: 'slow' });
  const handle = fixture.spawn(STREAM_ARGS, { stdin: 'long running task' });
  t.after(() => {
    try {
      handle.child.kill('SIGKILL');
    } catch {
      // already exited
    }
  });
  const initLine = await handle.waitForLine(line => line.includes('"subtype":"init"'), { timeoutMs: 5000, label: 'system/init line' });
  assert.match(initLine, /"type":"system"/);
  const [recordedBeforeExit] = await fixture.waitForInvocations(1);
  assert.equal(recordedBeforeExit.stdin, 'long running task');

  handle.kill('SIGINT');
  const { code, signal } = await handle.exited;
  assert.equal(signal, null);
  assert.equal(code, 130);
  const [recorded] = await fixture.invocations();
  assert.equal(recorded.exit_code, 130);
  assert.equal(recorded.signal, 'SIGINT');
});

test('unknown or invented flags are rejected with exit code 42 before touching state', async t => {
  const fixture = await createQoderFixture(t);
  const unknown = await fixture.run([...STREAM_ARGS, '--max-turns', '3'], { stdin: 'x' });
  assert.equal(unknown.code, 42);
  assert.equal(unknown.stdout, '');
  assert.match(unknown.stderr, /unknown option '--max-turns'/);
  assert.match(unknown.stderr, /qodercli --help/);
  assert.equal((await fixture.invocations()).length, 0);

  const invalidFormat = await fixture.run(['-p', '--output-format', 'yaml'], { stdin: 'x' });
  assert.equal(invalidFormat.code, 42);
  assert.match(invalidFormat.stderr, /--output-format/);

  const missingValue = await fixture.run(['-p', '--model'], { stdin: 'x' });
  assert.equal(missingValue.code, 42);
  assert.match(missingValue.stderr, /requires an argument/);
});

test('the stdin prompt is recorded verbatim and an env override can flip the control file', async t => {
  const fixture = await createQoderFixture(t);
  const prompt = 'explain the diff\nsecond line with "quotes" ✓';
  const result = await fixture.run([...STREAM_ARGS, '--cwd', fixture.dir], {
    stdin: prompt,
    env: { QODER_FIXTURE_MODE: 'error_during_execution' }
  });
  assert.equal(result.code, 1);
  const [invocation] = await fixture.invocations();
  assert.equal(invocation.stdin, prompt);
  assert.equal(invocation.cwd, fixture.dir);
  assert.equal(invocation.mode, 'error_during_execution');
  assert.equal(invocation.exit_code, 1);
});

test('the helper cleans up its temp directory and the wrapper is directly spawnable', async () => {
  const fixture = await createQoderFixture();
  try {
    assert.ok(existsSync(fixture.executable), 'wrapper must exist');
    assert.equal(join(fixture.stateDir, 'control.json'), fixture.controlFile);
    const result = await fixture.run(['--version']);
    assert.equal(result.code, 0);
    assert.equal((await fixture.invocations()).length, 1);
    await fixture.setControl({ mode: 'error_during_execution' });
    const failed = await fixture.run(STREAM_ARGS, { stdin: 'x' });
    assert.equal(failed.code, 1);
  } finally {
    await fixture.cleanup();
  }
  assert.equal(existsSync(fixture.dir), false);
  await fixture.cleanup();
});

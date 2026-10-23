#!/usr/bin/env node
/**
 * Fake `qodercli` used by tests only.
 *
 * It reproduces the part of the real Qoder CLI 1.1.78 surface the adapter relies
 * on: `-p/--print`, `--output-format text|json|stream-json`, `--cwd`, `--model`,
 * `--reasoning-effort`, `--resume [id]`, `--session-id`, `--list-models`,
 * `--version`, and the permission/tool flags accepted by the real binary.
 * Anything else (for example the invented `--max-turns`) is rejected with exit
 * code 42, so tests catch flags the real CLI does not support.
 *
 * The prompt is read from stdin (or from one positional argument, like the real
 * CLI). Behaviour is driven by `<stateDir>/control.json`, `QODER_FIXTURE_MODE`
 * and `QODER_FIXTURE_CONTROL_JSON`, so a test can flip a scenario without
 * touching this file. Supported print-mode controls:
 *   - mode: success | error_during_execution | error_max_turns |
 *           exit_without_result | protocol_garbage | not_logged_in | slow |
 *           permission_mismatch_burst
 *   - resume_mismatch: a `--resume <id>` run answers with a different session id
 *   - reported_permission_mode: override the camelCase value in system/init
 *   - permission_mismatch_burst: init + success result + exit 0 in one write
 * Supported `--list-models` controls (models_mode):
 *   - text (default, exact real catalogue: "MODEL" header then one name per line)
 *   - json | header_only | diagnostics | hang | not_logged_in
 *
 * Every invocation is recorded to `<stateDir>/invocations/<n>.json` and every
 * session to `<stateDir>/sessions/<session id>.json`. Nothing here touches the
 * network or the user's home directory / credentials.
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const VERSION = '1.1.78';

export const EXIT_CODES = Object.freeze({
  ok: 0,
  general: 1,
  auth: 41,
  badArguments: 42,
  sandbox: 44,
  config: 52,
  maxTurns: 53,
  tool: 54,
  cancelled: 130,
  terminated: 143
});

export const LOGIN_REQUIRED_MESSAGE = 'Not logged in. Run `qodercli login` to authenticate.';

// Exact model list printed by the real Qoder CLI 1.1.78 (`qodercli --list-models`).
export const DEFAULT_MODELS = Object.freeze([
  Object.freeze({ id: 'Auto', name: 'Auto', default: true }),
  Object.freeze({ id: 'Ultimate', name: 'Ultimate', default: false }),
  Object.freeze({ id: 'Fast', name: 'Fast', default: false }),
  Object.freeze({ id: 'Efficient', name: 'Efficient', default: false }),
  Object.freeze({ id: 'Sonus', name: 'Sonus', default: false }),
  Object.freeze({ id: 'Cantus', name: 'Cantus', default: false }),
  Object.freeze({ id: 'Qwen3.8-Max', name: 'Qwen3.8-Max', default: false }),
  Object.freeze({ id: 'Qwen3.8-Flash', name: 'Qwen3.8-Flash', default: false }),
  Object.freeze({ id: 'Kimi-K3', name: 'Kimi-K3', default: false }),
  Object.freeze({ id: 'Kimi-K2.8-Preview', name: 'Kimi-K2.8-Preview', default: false }),
  Object.freeze({ id: 'GLM-5.3', name: 'GLM-5.3', default: false }),
  Object.freeze({ id: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash', default: false }),
  Object.freeze({ id: 'DeepSeek-V4-Pro', name: 'DeepSeek-V4-Pro', default: false }),
  Object.freeze({ id: 'DeepSeek-Flash', name: 'DeepSeek-Flash', default: false }),
  Object.freeze({ id: 'MiniMax-M3.1-Flash', name: 'MiniMax-M3.1-Flash', default: false })
]);

export const CONTROL_DEFAULTS = Object.freeze({
  mode: 'success',
  version: VERSION,
  model: 'Auto',
  sessionId: null,
  sessionSeed: null,
  resume_mismatch: false,
  burst: false,
  long_line: false,
  result_without_init: false,
  exit_after_result: null,
  signal_after_result: null,
  exit_code: null,
  longLineBytes: 3 * 1024 * 1024 + 1024,
  longLineSleepMs: 1500,
  resultText: 'Qoder fixture: completed the requested task.',
  assistantText: 'Qoder fixture assistant reply.',
  errorAssistantText: 'Qoder fixture assistant stopped on an error.',
  thinkingText: 'Considering the request before answering.',
  toolName: 'Read',
  toolInput: null,
  toolResultText: 'fixture file contents',
  errors: null,
  exitCode: null,
  numTurns: 1,
  usage: Object.freeze({
    input_tokens: 128,
    output_tokens: 32,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0
  }),
  tools: Object.freeze(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep']),
  permission_denials: [],
  sigint_delay_ms: 0,
  ignore_sigterm: false,
  ignore_sigint: false,
  hang_without_output: false,
  models_mode: null,
  models: null,
  modelsHangMs: 65000,
  garbageLines: null,
  delayMs: 0,
  stdinTimeoutMs: 1500,
  slowMaxMs: 20000
});

const HELP_TEXT = `Usage: qodercli [options]

Options:
  -p, --print                      Print the response and exit (non-interactive)
      --output-format <format>     Output format: text, json, stream-json (default: text)
      --input-format <format>      Input format: text, stream-json (default: text)
      --cwd <directory>            Working directory for the session
      --model <model>              Model id (see --list-models)
      --reasoning-effort <effort>  Reasoning effort: low, medium, high
      --resume [session_id]        Resume a previous session
      --session-id <session_id>    Use a specific session id for a new session
      --permission-mode <mode>     Set the permission mode (choices:
                                   default, accept_edits,
                                   bypass_permissions, dont_ask, auto)
      --allowed-tools <tools>      Comma-separated list of allowed tools
      --disallowed-tools <tools>   Comma-separated list of disallowed tools
      --max-output-tokens <count>  Maximum number of output tokens
      --list-models                List available models
      --version                    Print the version
  -h, --help                       Print this help`;

export class UsageError extends Error {}

const VALUE_FLAGS = new Map([
  ['--output-format', 'outputFormat'],
  ['--input-format', 'inputFormat'],
  ['--cwd', 'cwd'],
  ['--model', 'model'],
  ['--reasoning-effort', 'reasoningEffort'],
  ['--session-id', 'sessionId'],
  ['--permission-mode', 'permissionMode'],
  ['--allowed-tools', 'allowedTools'],
  ['--disallowed-tools', 'disallowedTools'],
  ['--max-output-tokens', 'maxOutputTokens']
]);

const OUTPUT_FORMATS = new Set(['text', 'json', 'stream-json']);
const INPUT_FORMATS = new Set(['text', 'stream-json']);
// Real CLI 1.1.78 accepts these snake_case --permission-mode values and reports
// them back in camelCase from system/init. The adapter must normalize aliases.
export const PERMISSION_MODES = Object.freeze(['default', 'accept_edits', 'bypass_permissions', 'dont_ask', 'auto']);
const PERMISSION_REPORTED = Object.freeze({
  default: 'default', accept_edits: 'acceptEdits', bypass_permissions: 'bypassPermissions', dont_ask: 'dontAsk', auto: 'auto'
});

export function parseArgs(argv) {
  const parsed = {
    argv: [...argv],
    print: false,
    outputFormat: null,
    inputFormat: null,
    cwd: null,
    model: null,
    reasoningEffort: null,
    resumeFlag: false,
    resume: null,
    sessionId: null,
    listModels: false,
    version: false,
    help: false,
    permissionMode: null,
    allowedTools: [],
    disallowedTools: [],
    maxOutputTokens: null,
    positionals: []
  };

  let index = 0;
  while (index < argv.length) {
    const raw = argv[index];
    let flag = raw;
    let inlineValue = null;
    if (raw.startsWith('--') && raw.includes('=')) {
      const separator = raw.indexOf('=');
      flag = raw.slice(0, separator);
      inlineValue = raw.slice(separator + 1);
    }

    const takeValue = name => {
      if (inlineValue !== null) return inlineValue;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('-')) throw new UsageError(`option '${name}' requires an argument`);
      index += 1;
      return next;
    };

    if (flag === '-p' || flag === '--print') parsed.print = true;
    else if (flag === '--version') parsed.version = true;
    else if (flag === '-h' || flag === '--help') parsed.help = true;
    else if (flag === '--list-models') parsed.listModels = true;
    else if (flag === '--resume') {
      parsed.resumeFlag = true;
      if (inlineValue !== null) {
        parsed.resume = inlineValue === '' ? null : inlineValue;
      } else {
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith('-')) {
          parsed.resume = next;
          index += 1;
        }
      }
    } else if (VALUE_FLAGS.has(flag)) {
      const value = takeValue(flag);
      if (flag === '--output-format') {
        if (!OUTPUT_FORMATS.has(value)) throw new UsageError(`invalid argument '${value}' for '--output-format' (expected text, json or stream-json)`);
        parsed.outputFormat = value;
      } else if (flag === '--input-format') {
        if (!INPUT_FORMATS.has(value)) throw new UsageError(`invalid argument '${value}' for '--input-format' (expected text or stream-json)`);
        parsed.inputFormat = value;
      } else {
        const key = VALUE_FLAGS.get(flag);
        if (key === 'permissionMode' && !PERMISSION_MODES.includes(value)) {
          throw new UsageError(`invalid argument '${value}' for '--permission-mode' (choices: ${PERMISSION_MODES.join(', ')})`);
        }
        if (key === 'allowedTools' || key === 'disallowedTools') parsed[key].push(...value.split(',').map(entry => entry.trim()).filter(Boolean));
        else parsed[key] = value;
      }
    } else if (raw.startsWith('-')) {
      throw new UsageError(`unknown option '${flag}'`);
    } else {
      parsed.positionals.push(raw);
    }
    index += 1;
  }
  return parsed;
}

export function sessionFileName(sessionId) {
  return `${String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
}

export function deterministicUuid(seed) {
  const bytes = createHash('sha256').update(seed).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function mergeControl(layers) {
  const merged = { ...CONTROL_DEFAULTS, usage: { ...CONTROL_DEFAULTS.usage } };
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue;
    for (const [key, value] of Object.entries(layer)) {
      if (key === 'usage' && value && typeof value === 'object') merged.usage = { ...merged.usage, ...value };
      else if (value !== undefined) merged[key] = value;
    }
  }
  return merged;
}

function stateDirectory() {
  const fromEnv = process.env.QODER_FIXTURE_STATE_DIR
    || (process.env.QODER_FIXTURE_CONTROL ? dirname(process.env.QODER_FIXTURE_CONTROL) : null);
  if (fromEnv) return resolve(fromEnv);
  return join(tmpdir(), 'qoder-cli-standalone-fixture');
}

async function loadControl(stateDir) {
  const controlFile = process.env.QODER_FIXTURE_CONTROL || join(stateDir, 'control.json');
  let fileControl = {};
  try {
    fileControl = JSON.parse(await readFile(controlFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  let envControl = {};
  if (process.env.QODER_FIXTURE_CONTROL_JSON) {
    try {
      envControl = JSON.parse(process.env.QODER_FIXTURE_CONTROL_JSON);
    } catch {
      envControl = {};
    }
  }
  const control = mergeControl([fileControl, envControl]);
  if (process.env.QODER_FIXTURE_MODE) control.mode = process.env.QODER_FIXTURE_MODE;
  return control;
}

function resolveSessionId(parsed, control, stateDir) {
  if (parsed.resume) return parsed.resume;
  if (parsed.sessionId) return parsed.sessionId;
  if (control.sessionId) return control.sessionId;
  return deterministicUuid(`${stateDir}\0${control.sessionSeed ?? 'default'}`);
}

function resumeMismatchSessionId(stateDir, sessionId) {
  return deterministicUuid(`${stateDir}\0resume-mismatch\0${sessionId}`);
}

function echoOf(prompt) {
  return String(prompt ?? '').slice(0, 80);
}

async function readPrompt(parsed, timeoutMs) {
  if (parsed.positionals.length > 0 && parsed.inputFormat !== 'stream-json') {
    return { text: parsed.positionals.join(' '), timedOut: false };
  }
  if (process.stdin.isTTY) return { text: '', timedOut: false };
  return new Promise(resolvePromise => {
    const chunks = [];
    let settled = false;
    const finish = timedOut => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onEnd);
      process.stdin.pause();
      resolvePromise({ text: Buffer.concat(chunks).toString('utf8'), timedOut });
    };
    const onData = chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const onEnd = () => finish(false);
    const timer = setTimeout(() => finish(true), Math.max(0, timeoutMs));
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.once('error', onEnd);
    process.stdin.resume();
  });
}

async function allocateInvocationFile(invocationsDir) {
  for (let number = 1; number <= 5000; number += 1) {
    const file = join(invocationsDir, `${number}.json`);
    try {
      const handle = await open(file, 'wx');
      await handle.close();
      return file;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('could not allocate a qoder fixture invocation record');
}

async function beginInvocation({ stateDir, parsed, control, cwd, sessionId, requestedSessionId, prompt, stdinTimedOut }) {
  const invocationsDir = join(stateDir, 'invocations');
  await mkdir(invocationsDir, { recursive: true });
  const record = {
    argv: parsed.argv,
    stdin: prompt,
    cwd,
    process_cwd: process.cwd(),
    session_id: sessionId,
    requested_session_id: requestedSessionId,
    ts: new Date().toISOString(),
    pid: process.pid,
    mode: control.mode,
    models_mode: control.models_mode,
    print: parsed.print,
    output_format: parsed.outputFormat ?? (parsed.print ? 'text' : null),
    input_format: parsed.inputFormat,
    model: parsed.model,
    reasoning_effort: parsed.reasoningEffort,
    resume: parsed.resume,
    resume_flag: parsed.resumeFlag,
    session_id_flag: parsed.sessionId,
    permission_mode: parsed.permissionMode,
    allowed_tools: parsed.allowedTools,
    disallowed_tools: parsed.disallowedTools,
    max_output_tokens: parsed.maxOutputTokens,
    stdin_timed_out: stdinTimedOut
  };
  const file = await allocateInvocationFile(invocationsDir);
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
  return { file, record };
}

async function finalizeInvocation(invocation, exitCode, signal = null) {
  if (!invocation) return;
  invocation.record.exit_code = exitCode;
  invocation.record.signal = signal;
  invocation.record.ended_at = new Date().toISOString();
  const temporary = `${invocation.file}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(invocation.record, null, 2)}\n`);
    await rename(temporary, invocation.file);
  } catch {
    // Recording must never change the fixture's observable exit behaviour.
  }
}

async function recordSessionCall({ stateDir, sessionId, parsed, control, prompt }) {
  const sessionsDir = join(stateDir, 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  const file = join(sessionsDir, sessionFileName(sessionId));
  let session;
  try {
    session = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    session = { id: sessionId, created_at: new Date().toISOString(), calls: [], conversation: [] };
  }
  session.updated_at = new Date().toISOString();
  session.calls = Array.isArray(session.calls) ? session.calls : [];
  session.conversation = Array.isArray(session.conversation) ? session.conversation : [];
  session.resumed = Boolean(parsed.resume);
  session.calls.push({
    index: session.calls.length + 1,
    prompt,
    mode: control.mode,
    argv: parsed.argv,
    resumed: Boolean(parsed.resume),
    at: session.updated_at
  });
  session.conversation.push({ role: 'user', content: prompt });
  if (control.mode === 'success' || control.mode === 'exit_without_result' || control.mode === 'slow') {
    session.conversation.push({ role: 'assistant', content: control.resultText });
  }
  await writeFile(file, `${JSON.stringify(session, null, 2)}\n`);
  return session;
}

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function hashId(value, length = 24) {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function initMessage({ sessionId, control, cwd, parsed, model }) {
  const requested = parsed.permissionMode ?? 'default';
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    cwd,
    model,
    // Real 1.1.78 reports camelCase here even though the flag is snake_case.
    permissionMode: control.reported_permission_mode ?? PERMISSION_REPORTED[requested] ?? requested,
    tools: Array.isArray(control.tools) ? control.tools : [...CONTROL_DEFAULTS.tools],
    mcp_servers: [],
    slash_commands: [],
    qodercli_version: control.version
  };
}

function assistantTextMessage({ sessionId, control, text, messageId, model }) {
  return {
    type: 'assistant',
    message: { id: messageId, role: 'assistant', model, content: [{ type: 'text', text }] },
    session_id: sessionId
  };
}

function successResultMessage({ control, sessionId, prompt }) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: `${control.resultText} ECHO:${echoOf(prompt)}`,
    session_id: sessionId,
    num_turns: control.numTurns,
    duration_ms: 42,
    duration_api_ms: 31,
    usage: control.usage,
    total_cost_usd: 0,
    permission_denials: Array.isArray(control.permission_denials) ? control.permission_denials : []
  };
}

function overriddenExitCode(control, fallback) {
  if (Number.isInteger(control.exit_code)) return control.exit_code;
  if (Number.isInteger(control.exitCode)) return control.exitCode;
  return fallback;
}

// A success result followed by a normal process exit is what the adapter treats
// as completion. `signal_after_result` defers the exit decision to dieBySignal.
const SIGNAL_AFTER_RESULT = Symbol('qoder-fixture-signal-after-result');

function successExitCode(control) {
  if (control.signal_after_result) return SIGNAL_AFTER_RESULT;
  return Number.isInteger(control.exit_after_result) ? control.exit_after_result : EXIT_CODES.ok;
}

async function flushStdout() {
  if (process.stdout.writableLength === 0) return;
  await new Promise(resolvePromise => process.stdout.once('drain', resolvePromise));
}

async function dieBySignal(signalName) {
  const name = String(signalName).toUpperCase();
  if (name !== 'SIGTERM' && name !== 'SIGKILL') throw new Error(`unsupported signal_after_result '${signalName}'`);
  process.removeAllListeners(name);
  await flushStdout();
  process.kill(process.pid, name);
  // The process normally dies on the line above; fall back to a normal exit so a
  // misconfigured fixture can never hang the test run.
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1000));
  process.exit(name === 'SIGKILL' ? 137 : EXIT_CODES.terminated);
}

function emitSuccess({ parsed, control, sessionId, cwd, model, outputFormat, prompt }) {
  const echo = echoOf(prompt);
  const assistantText = `${control.assistantText} ECHO:${echo}`;
  const result = successResultMessage({ control, sessionId, prompt });
  if (outputFormat === 'text') {
    process.stdout.write(`${result.result}\n`);
    return successExitCode(control);
  }
  if (outputFormat === 'json') {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return successExitCode(control);
  }
  // Real 1.1.78 emits hook/artifact system messages around system/init; adapters
  // must ignore system subtypes they do not know.
  emit({ type: 'system', subtype: 'hook_started', session_id: sessionId, hook_name: 'UserPromptSubmit' });
  emit({ type: 'system', subtype: 'artifacts_update', session_id: sessionId, artifacts: [] });
  emit(initMessage({ sessionId, control, cwd, parsed, model }));
  emit({ type: 'system', subtype: 'hook_response', session_id: sessionId, hook_name: 'UserPromptSubmit' });
  // Real 1.1.78 splits thinking and answer into two assistant lines that share
  // one assistant message id.
  const messageId = `msg_${hashId(`${sessionId}\0${echo}`)}`;
  emit({
    type: 'assistant',
    message: { id: messageId, role: 'assistant', model, content: [{ type: 'thinking', thinking: control.thinkingText, signature: '' }] },
    session_id: sessionId
  });
  emit(assistantTextMessage({ sessionId, control, text: assistantText, messageId, model }));
  const toolId = `toolu_${hashId(`${sessionId}\0tool`)}`;
  emit({
    type: 'assistant',
    message: {
      id: `msg_${hashId(`${sessionId}\0tool-message`)}`,
      role: 'assistant',
      model,
      content: [{
        type: 'tool_use',
        id: toolId,
        name: control.toolName,
        input: control.toolInput ?? { file_path: join(cwd, 'README.md'), offset: 1, limit: 20 }
      }]
    },
    session_id: sessionId
  });
  emit({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolId,
        content: [{ type: 'text', text: control.toolResultText }],
        is_error: false
      }]
    },
    session_id: sessionId
  });
  emit(result);
  return successExitCode(control);
}

// Success result written in ONE stdout write (one tick) right after stdin EOF.
function emitBurst({ parsed, control, sessionId, cwd, model, prompt }) {
  const echo = echoOf(prompt);
  const messageId = `msg_${hashId(`${sessionId}\0${echo}`)}`;
  const payload = [
    JSON.stringify(initMessage({ sessionId, control, cwd, parsed, model })),
    JSON.stringify(assistantTextMessage({ sessionId, control, text: `${control.assistantText} ECHO:${echo}`, messageId, model })),
    JSON.stringify(successResultMessage({ control, sessionId, prompt }))
  ].join('\n');
  process.stdout.write(`${payload}\n`);
  return successExitCode(control);
}

// Permission mismatch that must stay terminal even though a success result and a
// normal exit follow in the same stdout chunk.
function emitPermissionMismatchBurst({ parsed, control, sessionId, cwd, model, prompt }) {
  const echo = echoOf(prompt);
  const messageId = `msg_${hashId(`${sessionId}\0${echo}`)}`;
  const payload = [
    JSON.stringify(initMessage({ sessionId, control, cwd, parsed, model })),
    JSON.stringify(assistantTextMessage({ sessionId, control, text: `${control.assistantText} ECHO:${echo}`, messageId, model })),
    JSON.stringify(successResultMessage({ control, sessionId, prompt }))
  ].join('\n');
  process.stdout.write(`${payload}\n`);
  return EXIT_CODES.ok;
}

// Protocol error: a success result with no system/init before it.
function emitResultWithoutInit({ control, sessionId, prompt }) {
  process.stdout.write(`${JSON.stringify(successResultMessage({ control, sessionId, prompt }))}\n`);
  return successExitCode(control);
}

// A >3MB single line with NO trailing newline and no result, to prove the
// adapter enforces a byte cap instead of buffering unboundedly.
async function emitLongLine({ parsed, control, sessionId, cwd, model, outputFormat }) {
  if (outputFormat !== 'text') emit(initMessage({ sessionId, control, cwd, parsed, model }));
  const bytes = Number.isFinite(control.longLineBytes) ? control.longLineBytes : CONTROL_DEFAULTS.longLineBytes;
  process.stdout.write('x'.repeat(Math.max(0, Math.trunc(bytes))));
  const sleepMs = Number.isFinite(control.longLineSleepMs) ? control.longLineSleepMs : CONTROL_DEFAULTS.longLineSleepMs;
  await new Promise(resolvePromise => setTimeout(resolvePromise, sleepMs));
  return successExitCode(control);
}


function emitErrorResult({ parsed, control, sessionId, cwd, model, outputFormat, subtype, defaultExitCode }) {
  const errors = Array.isArray(control.errors) && control.errors.length > 0
    ? control.errors.map(String)
    : [`qodercli fixture: ${subtype}`];
  const result = {
    type: 'result',
    subtype,
    is_error: true,
    result: '',
    session_id: sessionId,
    num_turns: control.numTurns,
    duration_ms: 42,
    duration_api_ms: 31,
    usage: control.usage,
    errors,
    permission_denials: Array.isArray(control.permission_denials) ? control.permission_denials : []
  };
  const exitCode = overriddenExitCode(control, defaultExitCode);
  if (outputFormat === 'text') {
    process.stderr.write(`error: ${errors.join('; ')}\n`);
    return exitCode;
  }
  if (outputFormat === 'json') {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return exitCode;
  }
  emit({ type: 'system', subtype: 'hook_started', session_id: sessionId, hook_name: 'UserPromptSubmit' });
  emit(initMessage({ sessionId, control, cwd, parsed, model }));
  emit(assistantTextMessage({ sessionId, control, text: control.errorAssistantText, messageId: `msg_${hashId(`${sessionId}\0error`)}`, model }));
  emit(result);
  return exitCode;
}

function emitWithoutResult({ parsed, control, sessionId, cwd, model, outputFormat }) {
  const messageId = `msg_${hashId(`${sessionId}\0partial`)}`;
  const assistant = assistantTextMessage({ sessionId, control, text: control.assistantText, messageId, model });
  if (outputFormat === 'text') {
    process.stdout.write(`${control.assistantText}\n`);
    return EXIT_CODES.ok;
  }
  if (outputFormat === 'json') {
    process.stdout.write(`${JSON.stringify(assistant)}\n`);
    return EXIT_CODES.ok;
  }
  emit({ type: 'system', subtype: 'hook_started', session_id: sessionId, hook_name: 'UserPromptSubmit' });
  emit(initMessage({ sessionId, control, cwd, parsed, model }));
  emit(assistant);
  return EXIT_CODES.ok;
}

function emitGarbage(control) {
  const lines = Array.isArray(control.garbageLines) && control.garbageLines.length > 0
    ? control.garbageLines.map(String)
    : [`Starting Qoder CLI v${control.version} ...`, '[telemetry] session started', 'Warning: unexpected output {not-json'];
  process.stdout.write(`${lines.join('\n')}\n`);
  return EXIT_CODES.ok;
}

function holdOpen(control) {
  return new Promise(resolvePromise => {
    const keepAlive = setInterval(() => {}, 1000);
    const safety = setTimeout(() => {
      clearInterval(keepAlive);
      resolvePromise();
    }, Number.isFinite(control.slowMaxMs) ? control.slowMaxMs : CONTROL_DEFAULTS.slowMaxMs);
    void safety;
    void keepAlive;
  });
}

async function emitSlow({ parsed, control, sessionId, cwd, model, outputFormat }) {
  if (outputFormat === 'stream-json') emit(initMessage({ sessionId, control, cwd, parsed, model }));
  await holdOpen(control);
  return overriddenExitCode(control, EXIT_CODES.ok);
}

function holdModelsCatalog(control) {
  return new Promise(resolvePromise => {
    const duration = Number.isFinite(control.modelsHangMs) ? control.modelsHangMs : CONTROL_DEFAULTS.modelsHangMs;
    const timer = setTimeout(resolvePromise, duration);
    void timer;
  });
}

function normalizedModels(control) {
  const source = Array.isArray(control.models) && control.models.length > 0 ? control.models : [...DEFAULT_MODELS];
  return source.map(model => {
    if (typeof model === 'string') return { id: model, name: model, default: model === 'Auto' };
    const id = String(model.id ?? model.name ?? '');
    const entry = { id, name: String(model.name ?? model.id ?? ''), default: Boolean(model.default) };
    if (Array.isArray(model.efforts)) entry.efforts = model.efforts.map(String);
    return entry;
  });
}

function renderModelsText(control) {
  const models = normalizedModels(control);
  return `${['MODEL', ...models.map(model => model.name)].join('\n')}\n`;
}

function renderModelsJson(control) {
  return `${JSON.stringify(normalizedModels(control), null, 2)}\n`;
}

function modelsModeFor(control) {
  if (control.models_mode) return control.models_mode;
  if (control.mode === 'not_logged_in') return 'not_logged_in';
  return 'text';
}

async function run({ parsed, control, stateDir }) {
  let invocation = null;
  const exitFromSignal = (exitCode, signal) => {
    const finish = () => process.exit(exitCode);
    if (invocation) finalizeInvocation(invocation, exitCode, signal).finally(finish);
    else finish();
  };
  process.on('SIGINT', () => {
    // A real CLI may take a moment to unwind after Ctrl-C. Tests can delay the
    // exit to prove follow-up work stays blocked until the old child is gone.
    if (control.ignore_sigint) return;
    const delay = Number.isFinite(control.sigint_delay_ms) ? control.sigint_delay_ms : 0;
    if (delay > 0) setTimeout(() => exitFromSignal(EXIT_CODES.cancelled, 'SIGINT'), delay);
    else exitFromSignal(EXIT_CODES.cancelled, 'SIGINT');
  });
  process.on('SIGTERM', () => {
    // A stuck CLI may ignore a polite shutdown request; the adapter must still
    // bound the wait and escalate to SIGKILL.
    if (control.ignore_sigterm) return;
    exitFromSignal(EXIT_CODES.terminated, 'SIGTERM');
  });
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});

  const cwd = parsed.cwd ? resolve(parsed.cwd) : process.cwd();
  const commandMode = parsed.help ? 'help'
    : parsed.version ? 'version'
      : parsed.listModels ? 'list-models'
        : parsed.print ? 'print' : 'unsupported';

  if (commandMode === 'help') {
    invocation = await beginInvocation({ stateDir, parsed, control, cwd, sessionId: null, requestedSessionId: null, prompt: '', stdinTimedOut: false });
    // `help_text` lets a test emulate an older CLI that does not declare
    // --permission-mode at all.
    process.stdout.write(`${control.help_text ?? HELP_TEXT}\n`);
    await finalizeInvocation(invocation, EXIT_CODES.ok);
    return EXIT_CODES.ok;
  }

  if (commandMode === 'version') {
    invocation = await beginInvocation({ stateDir, parsed, control, cwd, sessionId: null, requestedSessionId: null, prompt: '', stdinTimedOut: false });
    process.stdout.write(`${control.version}\n`);
    await finalizeInvocation(invocation, EXIT_CODES.ok);
    return EXIT_CODES.ok;
  }

  if (commandMode === 'list-models') {
    invocation = await beginInvocation({ stateDir, parsed, control, cwd, sessionId: null, requestedSessionId: null, prompt: '', stdinTimedOut: false });
    const modelsMode = modelsModeFor(control);
    if (modelsMode === 'not_logged_in') {
      process.stderr.write(`${LOGIN_REQUIRED_MESSAGE}\n`);
      await finalizeInvocation(invocation, EXIT_CODES.general);
      return EXIT_CODES.general;
    }
    if (modelsMode === 'diagnostics') {
      // A catalog probe must tolerate warning-only output: no MODEL header here.
      process.stdout.write('Warning: model catalog is temporarily unavailable.\n');
      process.stderr.write('Error: failed to load the model catalog (qoderfixture diagnostics mode).\n');
      await finalizeInvocation(invocation, EXIT_CODES.ok);
      return EXIT_CODES.ok;
    }
    if (modelsMode === 'hang') {
      // A catalog probe must not block the backend: it has to give up by itself.
      await holdModelsCatalog(control);
      await finalizeInvocation(invocation, EXIT_CODES.ok);
      return EXIT_CODES.ok;
    }
    if (modelsMode === 'header_only') {
      process.stdout.write('MODEL\n');
      await finalizeInvocation(invocation, EXIT_CODES.ok);
      return EXIT_CODES.ok;
    }
    if (modelsMode === 'json') process.stdout.write(renderModelsJson(control));
    else process.stdout.write(renderModelsText(control));
    await finalizeInvocation(invocation, EXIT_CODES.ok);
    return EXIT_CODES.ok;
  }

  if (commandMode === 'unsupported') {
    invocation = await beginInvocation({ stateDir, parsed, control, cwd, sessionId: null, requestedSessionId: null, prompt: '', stdinTimedOut: false });
    process.stderr.write('error: the qoder fixture only supports non-interactive mode; pass -p/--print\n');
    await finalizeInvocation(invocation, EXIT_CODES.badArguments);
    return EXIT_CODES.badArguments;
  }

  const notLoggedIn = control.mode === 'not_logged_in';
  const stdinTimeout = notLoggedIn
    ? Math.min(control.stdinTimeoutMs, 250)
    : control.mode === 'slow' ? Math.min(control.stdinTimeoutMs, 400) : control.stdinTimeoutMs;
  const { text: prompt, timedOut } = await readPrompt(parsed, stdinTimeout);
  const requestedSessionId = resolveSessionId(parsed, control, stateDir);
  const sessionId = control.resume_mismatch && parsed.resume
    ? resumeMismatchSessionId(stateDir, requestedSessionId)
    : requestedSessionId;
  if (!notLoggedIn) await recordSessionCall({ stateDir, sessionId: requestedSessionId, parsed, control, prompt });
  invocation = await beginInvocation({
    stateDir, parsed, control, cwd, sessionId, requestedSessionId, prompt, stdinTimedOut: timedOut
  });

  if (notLoggedIn) {
    process.stderr.write(`${LOGIN_REQUIRED_MESSAGE}\n`);
    await finalizeInvocation(invocation, EXIT_CODES.auth);
    return EXIT_CODES.auth;
  }

  if (control.delayMs > 0) await new Promise(resolvePromise => setTimeout(resolvePromise, control.delayMs));

  if (control.hang_without_output || control.mode === 'hang_without_output') {
    // No init, no result: only a bounded terminate may end this process.
    await holdOpen(control);
    return overriddenExitCode(control, EXIT_CODES.ok);
  }

  const outputFormat = parsed.outputFormat ?? 'text';
  const model = parsed.model ?? control.model;
  const context = { parsed, control, sessionId, cwd, model, outputFormat, prompt };
  let exitCode;
  // Protocol / stream-shape variants are flags so they also work on top of the
  // success mode (they can be selected either as a flag or as a mode name).
  if (control.permission_mismatch_burst || control.mode === 'permission_mismatch_burst') {
    exitCode = emitPermissionMismatchBurst(context);
  } else if (control.result_without_init || control.mode === 'result_without_init') {
    exitCode = emitResultWithoutInit(context);
  } else if (control.burst || control.mode === 'burst') {
    exitCode = emitBurst(context);
  } else if (control.long_line || control.mode === 'long_line') {
    exitCode = await emitLongLine(context);
  } else {
    switch (control.mode) {
      case 'success':
        exitCode = emitSuccess(context);
        break;
      case 'error_during_execution':
        exitCode = emitErrorResult({ ...context, subtype: 'error_during_execution', defaultExitCode: EXIT_CODES.general });
        break;
      case 'error_max_turns':
        exitCode = emitErrorResult({ ...context, subtype: 'error_max_turns', defaultExitCode: EXIT_CODES.maxTurns });
        break;
      case 'exit_without_result':
        exitCode = emitWithoutResult(context);
        break;
      case 'protocol_garbage':
        exitCode = emitGarbage(control);
        break;
      case 'slow':
        exitCode = await emitSlow(context);
        break;
      default:
        process.stderr.write(`qodercli fixture: unknown control mode '${control.mode}'\n`);
        exitCode = EXIT_CODES.general;
        break;
    }
  }
  if (exitCode === SIGNAL_AFTER_RESULT) {
    await dieBySignal(control.signal_after_result);
    exitCode = EXIT_CODES.terminated;
  }
  await finalizeInvocation(invocation, exitCode);
  return exitCode;
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`error: ${error.message}\nqodercli: run \`qodercli --help\` for usage.\n`);
      return EXIT_CODES.badArguments;
    }
    throw error;
  }
  const stateDir = stateDirectory();
  const control = await loadControl(stateDir);
  return run({ parsed, control, stateDir });
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    if (pathToFileURL(process.argv[1]).href === import.meta.url) return true;
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().then(exitCode => {
    process.exitCode = typeof exitCode === 'number' ? exitCode : EXIT_CODES.general;
  }).catch(error => {
    process.stderr.write(`qodercli fixture internal error: ${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}

import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { QODER_PERMISSION_MODES, normalizeQoderPermission } from './permissions.mjs';

// Qoder CLI discovery and read-only probes. All probes are asynchronous: the
// shared backend also serves MCP calls and /health from the same event loop, so
// a slow or hung CLI must never block request handling. Nothing here reads
// account credentials; --version and --list-models are ordinary CLI commands.

export const QODER_VERSION_TIMEOUT_MS = 10000;
export const QODER_MODELS_TIMEOUT_MS = 20000;
export const QODER_PERMISSION_TIMEOUT_MS = 10000;
const MAX_PROBE_BYTES = 1024 * 1024;

const text = value => String(value ?? '');
const stripAnsi = value => text(value).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
const clean = (value, limit = 300) => stripAnsi(value)
  .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
  .replace(/\s+/g, ' ').trim().slice(0, limit);
const unparsed = message => Object.assign(new Error(message), { code: 'QODER_CATALOG_UNPARSED' });

// Run one CLI command with a hard timeout. Resolves to a result object instead
// of throwing, so callers can distinguish non-zero exits from spawn failures.
export function runCli(executable, args, { timeout = QODER_VERSION_TIMEOUT_MS, signal, maxBuffer = MAX_PROBE_BYTES } = {}) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true;resolve(value); } };
    let child;
    try {
      child = execFile(executable, args, {
        encoding: 'utf8', timeout, maxBuffer, signal, windowsHide: true,
      }, (error, stdout = '', stderr = '') => {
        const status = error ? (Number.isInteger(error.code) ? error.code : null) : 0;
        finish({
          status, stdout: text(stdout), stderr: text(stderr),
          timedOut: Boolean(error?.killed || error?.name === 'AbortError'),
          aborted: error?.name === 'AbortError',
          error: error ? clean(error.message, 300) : null,
        });
      });
    } catch (error) {
      finish({ status: null, stdout: '', stderr: '', timedOut: false, aborted: false, error: clean(error.message, 300) });
      return;
    }
    child.on('error', error => finish({
      status: null, stdout: '', stderr: '', timedOut: error?.name === 'AbortError',
      aborted: error?.name === 'AbortError', error: clean(error.message, 300),
    }));
  });
}

// Candidate executables, in the order the documentation and the official
// installer place them. A configured path is never silently replaced by one of
// these candidates.
export function qoderCandidates({ pathEnv = process.env.PATH ?? '', home = homedir(), platform = process.platform } = {}) {
  const names = platform === 'win32' ? ['qodercli.exe', 'qodercli.cmd', 'qoder.exe', 'qoder.cmd'] : ['qodercli', 'qoder'];
  const seen = new Set();
  const candidates = [];
  const add = value => {
    if (!value || seen.has(value)) return;
    seen.add(value);candidates.push(value);
  };
  for (const directory of pathEnv.split(delimiter)) {
    if (!directory) continue;
    for (const name of names) add(join(directory, name));
  }
  add(join(home, '.local', 'bin', 'qodercli'));
  add(join(home, '.qoder', 'entry', 'qoder'));
  add(join(home, '.qoder', 'bin', 'qodercli', platform === 'win32' ? 'qodercli.exe' : 'qodercli'));
  return candidates;
}

const isExecutable = candidate => {
  try { accessSync(candidate, constants.X_OK);return true; }
  catch { return false; }
};

// Verify a single executable with `--version`. Returns its version or throws a
// message the board can show; callers must not fall back to another binary
// after a configured path fails.
export async function probeExecutable(executable, { run = runCli, timeout = QODER_VERSION_TIMEOUT_MS, signal } = {}) {
  if (typeof executable !== 'string' || !isAbsolute(executable)) {
    throw Object.assign(new Error('Qoder CLI 可执行文件必须是绝对路径。'), { code: 'QODER_PATH_INVALID' });
  }
  if (!isExecutable(executable)) {
    throw Object.assign(new Error(`Qoder CLI 可执行文件不存在或不可执行：${executable}`), { code: 'QODER_NOT_FOUND' });
  }
  const result = await run(executable, ['--version'], { timeout, signal });
  const version = result.stdout.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0];
  if (result.error || result.timedOut || result.status !== 0 || !version) {
    const detail = result.timedOut ? '版本检查超时' : clean(result.stderr) || clean(result.stdout) || result.error || '没有输出';
    throw Object.assign(new Error(`Qoder CLI 版本检查失败（退出码 ${result.status ?? '未知'}）：${detail}`), { code: 'QODER_PROBE_FAILED' });
  }
  return { executable, version };
}

// Discover a working executable. An explicitly configured path is verified on
// its own; discovery only runs when no path was configured.
export async function resolveExecutable({ executable, pathEnv = process.env.PATH ?? '', home = homedir(), run = runCli, timeout = QODER_VERSION_TIMEOUT_MS, signal, platform = process.platform } = {}) {
  if (executable) return probeExecutable(executable, { run, timeout, signal });
  const tried = [];
  for (const candidate of qoderCandidates({ pathEnv, home, platform })) {
    if (!isExecutable(candidate)) continue;
    try { return await probeExecutable(candidate, { run, timeout, signal }); }
    catch (error) { tried.push(`${candidate}: ${error.message}`); }
  }
  const detail = tried.length ? `已尝试：${tried.slice(-3).join('；')}` : '未找到 qodercli 或 qoder 可执行文件';
  throw Object.assign(new Error(`Qoder CLI 未安装或不可用。请先安装官方 CLI（https://docs.qoder.com/cli/installation），再用 enable --executor qoder 配置其可执行路径。${detail}`), { code: 'QODER_NOT_FOUND' });
}

// Run the documented model listing command. Output formats have changed between
// releases, so the parser only accepts formats it can identify exactly; it
// never invents models from free-form text.
export function listModels(executable, { run = runCli, timeout = QODER_MODELS_TIMEOUT_MS, signal } = {}) {
  return run(executable, ['--list-models'], { timeout, signal });
}

export function listModelsError({ status, stdout, stderr, error, timedOut } = {}) {
  const combined = `${stderr}\n${stdout}`;
  if (/not logged in|not authenticated|please (?:log|sign) in|run\s+[`'"]?qodercli login/i.test(combined)) {
    return 'Qoder CLI 未登录：请先在终端运行 qodercli login 完成登录。';
  }
  if (timedOut) return 'Qoder CLI --list-models 超时，模型目录暂时不可用。';
  if (error) return `无法运行 Qoder CLI --list-models：${clean(error)}`;
  const detail = clean(stderr) || clean(stdout);
  return `Qoder CLI --list-models 失败（退出码 ${status ?? '未知'}）${detail ? `：${detail}` : '。'}`;
}

const PROVIDER = 'qoder';
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:+/@-]*$/;
const MODEL_HEADER = /^MODEL(?:\s+NAME)?\s*:?$/i;

function modelEntry(id, name, efforts = []) {
  const model = text(id).trim();
  if (!model || !MODEL_ID.test(model)) return null;
  const unique = [...new Set(efforts.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
  return { provider: PROVIDER, model, name: clean(name) || model, efforts: unique, default_effort: null };
}

function collect(entries) {
  const unique = [];
  const seen = new Set();
  for (const entry of entries ?? []) {
    if (!entry || seen.has(entry.model)) continue;
    seen.add(entry.model);unique.push(entry);
  }
  return unique;
}

function fromJson(value) {
  const list = Array.isArray(value) ? value
    : Array.isArray(value?.models) ? value.models
    : Array.isArray(value?.data) ? value.data
    : Array.isArray(value?.available_models) ? value.available_models : null;
  if (!list) return null;
  const models = [];
  for (const item of list) {
    if (typeof item === 'string') { const entry = modelEntry(item, item);if (entry) models.push(entry);continue; }
    if (!item || typeof item !== 'object') continue;
    const id = item.id ?? item.model ?? item.model_id ?? item.modelId ?? item.value;
    const name = item.name ?? item.display_name ?? item.displayName ?? item.label ?? id;
    const efforts = item.efforts ?? item.reasoning_efforts ?? item.reasoningEfforts ?? item.reasoning?.efforts ?? [];
    const entry = modelEntry(id, name, Array.isArray(efforts) ? efforts.map(String) : []);
    if (entry) models.push(entry);
  }
  return models;
}

// The real 1.1.78 output is a single-column list:
//   MODEL
//   Auto
//   ...
// Only that exact shape (or a structured JSON catalog) is accepted. Anything
// else, including exit-0 diagnostics, becomes a catalog error instead of a
// guessed model list.
export function parseModelList(output) {
  const cleaned = stripAnsi(text(output)).trim();
  if (!cleaned) throw Object.assign(new Error('Qoder CLI --list-models 没有输出任何模型目录。'), { code: 'QODER_CATALOG_EMPTY' });
  if (/^[[{]/.test(cleaned)) {
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch { throw unparsed('Qoder CLI --list-models 输出了无法解析的 JSON 目录。'); }
    const models = collect(fromJson(parsed));
    if (!models.length) throw unparsed('Qoder CLI --list-models 的 JSON 目录中没有可路由的模型标识。');
    return models;
  }
  const lines = cleaned.split(/\r?\n/).map(line => line.trim());
  const header = lines.findIndex(line => MODEL_HEADER.test(line));
  if (header === -1) {
    throw unparsed(`无法识别 Qoder CLI --list-models 输出（缺少 MODEL 表头），不按猜测分词。首行：${clean(lines[0], 120)}`);
  }
  const models = [];
  const unexpected = [];
  for (const line of lines.slice(header + 1)) {
    if (!line) continue;
    if (/^[-=+_|·•\s]+$/.test(line)) continue;
    // A single column of model identifiers only: a line with whitespace is a
    // description or diagnostic, not a routable model ID.
    if (/\s/.test(line)) { unexpected.push(line);continue; }
    const entry = modelEntry(line, line);
    if (entry) models.push(entry);else unexpected.push(line);
  }
  if (!models.length) {
    throw unparsed(`Qoder CLI --list-models 输出中没有可用的模型名称${unexpected.length ? `（首行无法识别：${clean(unexpected[0], 120)}）` : ''}。`);
  }
  if (unexpected.length) {
    throw unparsed(`Qoder CLI --list-models 输出包含无法识别的非单列内容（${clean(unexpected[0], 120)}），已停止解析以免把诊断当模型。`);
  }
  return collect(models);
}

// Only catalog-provided effort values are ever passed; "default" omits the
// flag so the model's own default applies.
export function resolveEffort(model, requested) {
  if (requested === undefined || requested === null || requested === 'default') return null;
  if (typeof requested !== 'string' || !requested.trim()) throw new Error('无效的 Qoder 思考强度。');
  const efforts = Array.isArray(model?.efforts) ? model.efforts : [];
  if (!efforts.includes(requested)) {
    throw new Error(efforts.length
      ? `所选 Qoder 思考强度当前不可用；可用值：${efforts.join('、')}。`
      : '当前 Qoder 模型目录未声明思考强度选项；新任务将跟随模型默认，不显式传 --reasoning-effort。');
  }
  return requested;
}


// Parse the real `--permission-mode` choices block from `qodercli --help`.
// 1.1.78 prints:
//   --permission-mode <mode>   Set the permission mode (choices:
//                              default, accept_edits,
//                              bypass_permissions, dont_ask, auto)
// Only that explicit choices declaration is trusted: an older help text that
// does not declare the option (or a changed format) becomes "unsupported"
// instead of a guessed list.
export function parsePermissionModes(helpText) {
  const lines = stripAnsi(text(helpText)).split(/\r?\n/);
  const start = lines.findIndex(line => /--permission-mode\b/.test(line));
  if (start === -1) return null;
  const block = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    // A following option starts again at the option column; the choices
    // continuation lines are indented farther and never start with a dash.
    if (/^\s{0,4}-{1,2}[A-Za-z]/.test(line)) break;
    if (!line.trim()) break;
    block.push(line);
  }
  const choices = block.join(' ').match(/\(choices:\s*([^)]*)\)/i)?.[1];
  if (!choices) return null;
  return choices.split(',').map(value => value.trim()).filter(Boolean);
}

// A real process probe, cached by the adapter. It never invents a mode: the
// returned list is the intersection of the help text's declared choices with the
// snake_case modes the board knows how to store and explain.
export async function readPermissionModes(executable, { run = runCli, timeout = QODER_PERMISSION_TIMEOUT_MS, signal } = {}) {
  const result = await run(executable, ['--help'], { timeout, signal });
  if (result.error || result.timedOut || result.status !== 0) {
    const detail = result.timedOut ? '读取超时' : clean(result.stderr) || clean(result.stdout) || result.error || '没有输出';
    return { available: false, modes: [], reason: `Qoder CLI --help ${detail}，无法确认新会话权限能力。` };
  }
  const choices = parsePermissionModes(result.stdout);
  if (!choices) {
    return { available: false, modes: [], reason: '当前 Qoder CLI 未声明 --permission-mode 选项，不能设置新会话权限。' };
  }
  const modes = QODER_PERMISSION_MODES.filter(mode => choices.some(value => normalizeQoderPermission(value) === mode));
  if (!modes.length) {
    return { available: false, modes: [], reason: '当前 Qoder CLI 的 --permission-mode 取值不在看板支持的范围内。' };
  }
  return { available: true, modes, reason: '' };
}

import { spawn as nodeSpawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OrderBook } from './orders.mjs';
import { ReceiptStore } from './receipt-store.mjs';
import {
  listModels, listModelsError, parseModelList, resolveEffort, resolveExecutable, readPermissionModes,
} from './qoder-cli.mjs';
import {
  normalizeQoderPermission, permissionControl, permissionValueName, readExecutorPermission,
} from './permissions.mjs';

// Qoder CLI adapter. Every work order owns one short-lived headless child
// (`-p --output-format stream-json`), never a long-lived interactive process.
// The native session UUID reported by `system/init` is kept exactly as received
// and reused with `--resume` for follow-up work. Completion requires a valid
// terminal `result` message AND a normal process exit: neither an exit code nor
// partial text alone is ever reported as success.
const PROVIDER = 'qoder';
const MAX_TEXT = 20000;
const MAX_STDERR = 4000;
const MAX_LINE = 2 * 1024 * 1024;
const DSH_ONLY_WORKSPACES = 'Qoder CLI 使用任务目录（--cwd），没有桌面项目注册表；请通过 directory 指定工作目录。';
// A result was received but the process has not exited yet; completion is only
// declared after the exit code confirms a normal end.
const SETTLED = new Set(['completed', 'failed', 'cancelled', 'blocked']);
const settled = status => SETTLED.has(status);

const clean = (value, limit = 400) => String(value ?? '')
  .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
  .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
  .replace(/\s+/g, ' ').trim().slice(0, limit);

function deferred() {
  let resolve;let reject;
  const promise = new Promise((res, rej) => { resolve = res;reject = rej; });
  // A receipt that never reaches send() must not surface an unhandled
  // rejection; every real caller still awaits the original promise.
  promise.catch(() => {});
  return { promise, resolve, reject, value: undefined };
}

export class Qoder {
  constructor(settings = {}, { spawn = nodeSpawn, now = Date.now } = {}) {
    this.settings = settings;
    this.spawn = spawn;
    this.now = now;
    this.book = new OrderBook(settings.home);
    this.receipts = join(settings.home, 'qoder-receipts');
    // Only unfinished receipts are held in memory. Completed bodies stay on
    // disk; the index keeps just the order/session locator needed for restart,
    // follow-ups and cancellation.
    this.store = new ReceiptStore(this.receipts, {
      isTerminal: settled,
      cacheSize: settings.receiptCacheSize ?? 32,
    });
    this.turns = new Map();
    this.processes = new Map();
    this.writes = Promise.resolve();
    this.writeError = null;
    this.closed = false;
    this.catalogCache = null;
    this.catalogAt = 0;
    this.catalogPending = null;
    this.catalogController = null;
    this.catalogError = null;
    this.catalogErrorAt = 0;
    this.executableCache = null;
    this.permissionProbe = null;
    this.startupTimeoutMs = settings.startupTimeoutMs ?? 120000;
    this.idleTimeoutMs = settings.idleTimeoutMs ?? 30 * 60 * 1000;
    this.cancelGraceMs = settings.cancelGraceMs ?? 5000;
    // Every process this adapter creates gets a bounded end: request signal,
    // bounded grace period, then SIGKILL. Only our own child PID is signalled.
    this.terminateGraceMs = settings.terminateGraceMs ?? 3000;
    this.killWaitMs = settings.killWaitMs ?? 2000;
    this.catalogTtlMs = settings.catalogTtlMs ?? 5 * 60 * 1000;
    this.exitGraceMs = settings.exitGraceMs ?? 10000;
  }

  async open() {
    for (const receipt of await this.store.open()) {
      this.turns.set(receipt.order_id, receipt);
      if (!settled(receipt.status) && receipt.status !== 'uncertain') {
        // The previous consumer is gone together with its child processes. No
        // native transcript is read here and nothing is replayed: the honest
        // state is "uncertain" until a new order produces fresh evidence.
        receipt.status = 'uncertain';
        receipt.progress = '消费者重启时 Qoder CLI 进程已退出；原有任务的终态无法确认，不会自动重放。';
        receipt.output = { ...(receipt.output ?? {}), terminal_confirmed: false, conversation_id: receipt.conversation_id ?? null };
        await this.save(receipt);
      }
    }
  }

  // Read the real executable and model catalog. Results are cached briefly so
  // each consumer tick does not respawn the CLI, and concurrent refreshes share
  // one non-blocking probe: a hung CLI must not block the backend event loop or
  // other MCP/health reads. A missing CLI, missing login or an unreadable
  // listing becomes an explicit catalog error, never a guessed model list.
  async describe() {
    if (this.catalogCache && this.now() - this.catalogAt < this.catalogTtlMs) return this.catalogCache;
    // A failing probe (missing CLI, missing login, unreadable output) is cached
    // briefly too: otherwise every consumer tick would respawn the CLI.
    if (this.catalogError && this.now() - this.catalogErrorAt < (this.settings.catalogErrorTtlMs ?? 30000)) {
      throw new Error(this.catalogError);
    }
    if (this.catalogPending) return this.catalogPending;
    this.catalogController = new AbortController();
    const { signal } = this.catalogController;
    this.catalogPending = (async () => {
      const executable = await this.resolveExecutable(signal);
      const listing = await listModels(executable.executable, { signal, timeout: this.settings.catalogTimeoutMs });
      if (listing.aborted) throw new Error('Qoder CLI 模型目录读取已取消（消费者关闭）。');
      if (listing.error || listing.status !== 0) throw new Error(listModelsError(listing));
      const models = parseModelList(listing.stdout);
      const permission_control = await this.permissionCapability(executable.executable, signal);
      const catalog = {
        executor: 'qoder', executable: executable.executable, version: executable.version,
        capabilities: { directories: true, workspaces: false, follow_up: true, steer: false, cancel: true, conversations: false },
        models, permission_control,
      };
      this.catalogCache = catalog;
      this.catalogAt = this.now();
      this.catalogError = null;
      return catalog;
    })();
    try { return await this.catalogPending; }
    catch (error) {
      if (!signal.aborted) { this.catalogError = error.message;this.catalogErrorAt = this.now(); }
      throw error;
    } finally { this.catalogPending = null;this.catalogController = null; }
  }

  // Ask the real executable which permission modes its --help declares. The
  // probe is cached per executable so the board heartbeat does not respawn the
  // CLI on every consumer tick; a failed/absent declaration is reported as an
  // unsupported capability instead of guessing a value.
  async permissionCapability(executable, signal) {
    if (this.permissionProbe) return this.permissionProbe;
    const probed = await readPermissionModes(executable, { signal, timeout: this.settings.permissionTimeoutMs });
    this.permissionProbe = permissionControl('qoder', probed.modes, { available: probed.available, reason: probed.reason });
    return this.permissionProbe;
  }

  // The user-owned preference for newly created Qoder sessions. Reading the
  // stored setting is separate from the running capability check below: a
  // configured but unsupported value blocks dispatch instead of being dropped.
  newSessionPermission() {
    return readExecutorPermission(this.settings.home, 'qoder');
  }

  // A saved permission is only applied when the running CLI advertised it in
  // --help. This is validated before spawning, so an old CLI cannot silently
  // ignore the flag and run with another mode.
  requirePermissionSupport(catalog, permission) {
    const control = catalog?.permission_control;
    if (control?.available === true && Array.isArray(control.presets) && control.presets.includes(permission)) return;
    throw Object.assign(new Error(`当前 Qoder CLI 未提供新会话权限“${permissionValueName('qoder', permission)}”，已阻止派工。请升级并重新加载 Qoder 执行端后再试。`), { definite: true });
  }

  async resolveExecutable(signal) {
    if (this.executableCache) return this.executableCache;
    const executable = await resolveExecutable({
      executable: this.settings.executable,
      home: this.settings.userHome,
      signal,
    });
    this.executableCache = executable;
    return executable;
  }

  liveRecordForSession(sessionId) {
    // Liveness is decided by the actual child process, not by the receipt
    // status: a cancelled/failed/finishing order may still be winding down, and
    // a same-session follow-up must wait until it really exited.
    if (!sessionId) return null;
    for (const record of this.processes.values()) {
      if (record.exited) continue;
      const receipt = record.receipt;
      if (receipt.conversation_id === sessionId || receipt.native_session_id === sessionId
          || receipt.resume_from === sessionId) return record;
    }
    return null;
  }

  running(orderId) {
    const record = this.processes.get(orderId);
    return Boolean(record && !record.exited && record.child);
  }

  observe(ids) {
    return [...new Set(ids)].map(id => {
      const live = this.liveRecordForSession(id);
      return { id, status: live ? 'running' : this.store.hasSession(id) ? 'idle' : 'unloaded' };
    });
  }

  ready(id) {
    // A live child for this native session keeps follow-up work queued until it
    // exits; an old receipt is never treated as the current turn.
    return !this.liveRecordForSession(id);
  }

  // Locate the stored working directory/route for a follow-up. The adapter does
  // not guess: a conversation created outside these work orders has no verified
  // directory to resume in.
  async checkpoint(sessionId) {
    // The locator index carries the stored directory, route and permission, so
    // continuing an old conversation never loads its completed receipt body.
    const locator = this.store.session(sessionId);
    if (!locator) throw Object.assign(new Error('无法定位该 Qoder 会话的工作目录；续聊请使用原任务的 work_update（target_order）。'), { definite: true });
    return {
      conversation_id: sessionId, native_session_id: locator.native_session_id ?? sessionId,
      directory: locator.directory, route: locator.route ?? { provider: PROVIDER, model: null },
      // Follow-ups keep the original task's permission (a stored receipt value,
      // never a fresh read of the board) so a later board change cannot alter an
      // existing conversation.
      permission: locator.permission ?? null,
    };
  }

  async start(order) {
    if (this.closed) throw Object.assign(new Error('Qoder 消费者已关闭。'), { definite: true });
    const input = order.payload;
    const permission = await this.newSessionPermission();
    const catalog = await this.describe();
    const route = this.selectRoute(catalog, input);
    const directory = await this.taskDirectory(input.directory ?? this.settings.defaultDirectory);
    // Check capability and apply the choice before spawning. Qoder reports the
    // effective mode later in system/init; the spawn cannot wait for that
    // because the real CLI emits nothing before stdin is written.
    if (permission) this.requirePermissionSupport(catalog, permission);
    const receipt = {
      order_id: order.id, directory, route, native_session_id: null, permission,
      status: 'starting', progress: '正在启动 Qoder CLI…', text: '',
      started_at: new Date().toISOString(),
    };
    this.turns.set(order.id, receipt);
    this.spawnProcess(receipt, { executable: catalog.executable, resume: null });
    await this.save(receipt);
    // The native session id is only known after `system/init`; send() waits for
    // it before reporting the dispatch, so no conversation ID is ever invented.
    return { directory, route };
  }

  selectRoute(catalog, input) {
    const provider = input.provider ?? PROVIDER;
    if (provider !== PROVIDER) {
      throw Object.assign(new Error(`Qoder 执行端只接受 provider "${PROVIDER}"；请先从 runtime_info 选择可用模型。`), { definite: true });
    }
    if (input.model === undefined || input.model === null) {
      if (input.effort !== undefined && input.effort !== 'default') {
        throw Object.assign(new Error('未选择 Qoder 模型时不能固定思考强度；请先选择具体模型。'), { definite: true });
      }
      return { provider, model: null, effort: null };
    }
    const model = catalog.models.find(entry => entry.provider === provider && entry.model === input.model);
    if (!model) {
      throw Object.assign(new Error('所选 Qoder 模型当前不可用，请从 runtime_info 的模型目录重新选择。'), { definite: true });
    }
    const effort = resolveEffort(model, input.effort);
    return { provider, model: model.model, effort };
  }

  async taskDirectory(path) {
    if (typeof path !== 'string' || !isAbsolute(path)) {
      throw Object.assign(new Error('Qoder 需要绝对任务目录（directory 或已配置的默认目录）。'), { definite: true });
    }
    let directory;
    try { directory = await realpath(path); }
    catch { throw Object.assign(new Error(`Qoder 任务目录不存在：${path}`), { definite: true }); }
    if (!(await stat(directory)).isDirectory()) throw Object.assign(new Error('Qoder 任务目录必须是目录。'), { definite: true });
    return directory;
  }

  buildArgs({ directory, route, resume, permission }) {
    // Only flags verified against the real 1.1.78 `--help` are passed. In
    // particular there is no --max-turns. The permission flag is omitted when
    // the user follows the Qoder default, so the native default applies.
    const args = ['-p', '--output-format', 'stream-json', '--cwd', directory];
    if (route?.model) args.push('--model', route.model);
    if (route?.effort) args.push('--reasoning-effort', route.effort);
    if (permission) args.push('--permission-mode', permission);
    if (resume) args.push('--resume', resume);
    return args;
  }

  spawnProcess(receipt, { executable, resume }) {
    const orderId = receipt.order_id;
    const record = {
      receipt, executable, resume, child: null, exited: false, stderr: '', invalid: 0,
      init: deferred(), initResolved: false, exit: deferred(), timers: {}, stdout: '', promptWritten: false,
    };
    this.processes.set(orderId, record);
    const args = this.buildArgs({ directory: receipt.directory, route: receipt.route, resume, permission: receipt.permission ?? null });
    let child;
    try {
      child = this.spawn(executable, args, { cwd: receipt.directory, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      this.fail(record, { message: `Qoder CLI 启动失败：${clean(error.message)}`, kind: 'cli_error' });
      this.releaseProcess(record);
      throw Object.assign(new Error(`Qoder CLI 启动失败：${clean(error.message)}`), { definite: true });
    }
    record.child = child;
    child.on('error', error => this.fail(record, { message: `Qoder CLI 进程错误：${clean(error.message)}`, kind: 'cli_error' }));
    child.stdin.on('error', () => { /* a fast process may close stdin after a valid result */ });
    child.stderr.on('data', chunk => {
      record.stderr = (record.stderr + String(chunk)).slice(-MAX_STDERR);
    });
    // Byte-level framing instead of readline: readline only enforces a limit
    // after a newline, so an unterminated huge line could otherwise buffer
    // without bound. Here the pending buffer is capped before parsing.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.stdoutChunk(record, chunk));
    child.stdout.on('end', () => this.flushStdout(record));
    child.on('close', (code, signal) => this.exited(record, code, signal));
    // A process that never initializes is a startup/protocol failure, not a
    // reason to wait forever.
    record.timers.startup = setTimeout(() => {
      if (record.initResolved || settled(record.receipt.status)) return;
      this.fail(record, { message: `Qoder CLI 未在 ${this.startupTimeoutMs} ms 内返回会话初始化（协议超时），已终止。`, kind: 'timeout' });
      void this.terminate(record);
    }, this.startupTimeoutMs);
    record.timers.startup.unref?.();
    return record;
  }

  stdoutChunk(record, chunk) {
    if (record.aborted) return;
    if (record.exited && settled(record.receipt.status)) return;
    record.stdout += chunk;
    let index;
    while ((index = record.stdout.indexOf('\n')) !== -1) {
      const line = record.stdout.slice(0, index);
      record.stdout = record.stdout.slice(index + 1);
      this.receive(record, line);
      if (record.exited && settled(record.receipt.status)) return;
    }
    if (Buffer.byteLength(record.stdout, 'utf8') > MAX_LINE) {
      record.stdout = '';
      this.fail(record, {
        message: `Qoder CLI 输出了超过 ${MAX_LINE} 字节且没有换行的数据（协议错误），已终止；不会把未完成输出当作结果。`,
        kind: 'protocol_error',
      });
      void this.terminate(record);
    }
  }

  flushStdout(record) {
    if (record.aborted) { record.stdout = '';return; }
    if (record.stdout.trim()) {
      const line = record.stdout;
      record.stdout = '';
      this.receive(record, line);
    }
  }

  receive(record, line) {
    // A terminal adapter decision (permission mismatch, protocol abort) must not
    // be overwritten by later messages from the same stdout chunk, including a
    // success result. The record-level guard keeps the receipt at its honest
    // terminal state.
    if (record.aborted) return;
    const value = line.trim();
    if (!value) return;
    if (value.length > MAX_LINE) {
      this.fail(record, { message: 'Qoder CLI 输出单行过长，已按协议错误终止。', kind: 'protocol_error' });
      void this.terminate(record);
      return;
    }
    let message;
    try { message = JSON.parse(value); }
    catch {
      record.invalid++;
      this.fail(record, { message: `Qoder CLI 输出了无法解析的 stream-json 行（协议错误）：${clean(value, 160)}`, kind: 'protocol_error' });
      void this.terminate(record);
      return;
    }
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
      this.fail(record, { message: 'Qoder CLI 输出了缺少 type 的消息（协议错误）。', kind: 'protocol_error' });
      void this.terminate(record);
      return;
    }
    this.touch(record);
    const receipt = record.receipt;
    if (message.type === 'system') {
      if (message.subtype === 'init') this.initialized(record, message);
      return;
    }
    if (message.type === 'assistant') {
      this.assistant(record, message);
      return;
    }
    if (message.type === 'user') {
      const blocks = message.message?.content ?? message.content;
      if (Array.isArray(blocks) && blocks.some(block => block?.type === 'tool_result')) {
        receipt.progress = 'Qoder CLI 已收到工具结果，继续执行。';
        this.persist(receipt);
      }
      return;
    }
    if (message.type === 'stream_event') {
      const delta = message.event?.delta;
      if (delta?.type === 'text_delta' && delta.text) this.appendText(record, delta.text);
      else if (delta?.type === 'thinking_delta') receipt.progress = 'Qoder CLI 正在思考…';
      return;
    }
    if (message.type === 'result') {
      this.result(record, message);
      return;
    }
    // Other documented message types (hooks, task progress, artifacts, status)
    // are informational. Ignoring them keeps the adapter compatible with newer
    // CLIs without inventing terminal states.
  }

  touch(record) {
    if (settled(record.receipt.status)) return;
    if (record.timers.idle) clearTimeout(record.timers.idle);
    if (!record.initResolved) return;
    record.timers.idle = setTimeout(() => {
      if (settled(record.receipt.status)) return;
      this.fail(record, { message: `Qoder CLI 已 ${this.idleTimeoutMs} ms 没有输出，已终止；任务不能视为完成。`, kind: 'timeout' });
      void this.terminate(record);
    }, this.idleTimeoutMs);
    record.timers.idle.unref?.();
  }

  initialized(record, message) {
    if (settled(record.receipt.status)) return;
    const sessionId = message.session_id;
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      this.fail(record, { message: 'Qoder CLI 的 init 消息没有会话标识（协议错误）。', kind: 'protocol_error' });
      return;
    }
    if (record.resume && sessionId !== record.resume) {
      this.fail(record, {
        message: `Qoder CLI 恢复会话后返回了不同的会话标识（期望 ${record.resume}，实际 ${sessionId}），已停止派工以避免续聊错位。`,
        kind: 'protocol_error',
      });
      return;
    }
    const receipt = record.receipt;
    receipt.native_session_id = sessionId;
    receipt.conversation_id = sessionId;
    receipt.native_model = typeof message.model === 'string' ? message.model : null;
    receipt.native_permission_mode = typeof message.permissionMode === 'string' ? message.permissionMode : null;
    receipt.cli_version = typeof message.qodercli_version === 'string' ? message.qodercli_version : null;
    // Qoder reports the mode in its own camelCase spelling (accept_edits ->
    // acceptEdits). Compare through the alias table: only a genuinely different
    // mode may terminate the run, never a spelling difference.
    if (receipt.permission) {
      const reported = normalizeQoderPermission(receipt.native_permission_mode);
      if (reported !== receipt.permission) {
        this.permissionMismatch(record, { requested: receipt.permission, reported: receipt.native_permission_mode });
        return;
      }
    }
    if (!record.initResolved) {
      record.initResolved = true;
      record.init.value = sessionId;
      if (record.timers.startup) { clearTimeout(record.timers.startup);delete record.timers.startup; }
      record.init.resolve(sessionId);
    }
    if (!settled(receipt.status) && receipt.status !== 'finishing') receipt.progress = 'Qoder CLI 会话已就绪，正在提交任务…';
    this.persist(receipt);
    // The idle clock only makes sense after init: from here a silent CLI can be
    // bounded by the configured idle timeout.
    this.touch(record);
  }

  // The permission flag was accepted but the native init reports another mode.
  // Never claim success and never claim "nothing was delivered": once stdin has
  // been written the Qoder CLI may already be running the task. Before the
  // write the failure is definite because no prompt reached the CLI.
  permissionMismatch(record, { requested, reported }) {
    const receipt = record.receipt;
    const delivered = record.promptWritten === true;
    // This is the adapter's terminal decision for this order. Later init/result
    // messages in the same stdout chunk and the process exit must not rewrite it.
    record.aborted = 'permission_mismatch';
    for (const [name, timer] of Object.entries(record.timers)) {
      if (name === 'cancelGrace') continue;
      clearTimeout(timer);delete record.timers[name];
    }
    const requestedName = permissionValueName('qoder', requested);
    const reportedName = reported
      ? `${reported}${normalizeQoderPermission(reported) && normalizeQoderPermission(reported) !== reported ? `（${normalizeQoderPermission(reported)}）` : ''}`
      : '未返回';
    const message = delivered
      ? `Qoder CLI 回报的权限模式与请求不一致（请求 ${requestedName}，实际 ${reportedName}）；已终止且任务可能已提交，结果无法确认，不会自动重放。`
      : `Qoder CLI 回报的权限模式与请求不一致（请求 ${requestedName}，实际 ${reportedName}）；已在提交前终止，不会派工。`;
    receipt.status = delivered ? 'uncertain' : 'failed';
    receipt.error = message;
    receipt.progress = delivered ? 'Qoder CLI 权限模式不一致；任务可能已提交，结果无法确认。' : message;
    receipt.output = {
      text: receipt.text.slice(-MAX_TEXT), native_status: 'permission_mismatch', failure_kind: 'permission_mismatch',
      session_id: receipt.native_session_id ?? null, terminal_confirmed: false,
      requested_permission: requested, reported_permission: reported ?? null,
      delivery_uncertain: delivered,
    };
    receipt.updated_at = new Date().toISOString();
    this.persist(receipt);
    const failure = Object.assign(new Error(message), {
      ...(delivered ? { deliveryUnknown: true } : { definite: true }),
      output: structuredClone(receipt.output),
    });
    if (!record.initResolved) { record.initResolved = true; record.init.reject(failure); }
    if (!record.exited) void this.terminate(record);
  }

  assistant(record, message) {
    const receipt = record.receipt;
    const blocks = message.message?.content ?? message.content;
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (block?.type === 'text' && typeof block.text === 'string') this.appendText(record, block.text);
      else if (block?.type === 'tool_use') receipt.progress = `Qoder CLI 正在使用工具 ${clean(block.name ?? 'unknown', 80)}。`;
      else if (block?.type === 'thinking') receipt.progress = 'Qoder CLI 正在思考…';
    }
    this.persist(receipt);
  }

  appendText(record, text) {
    const receipt = record.receipt;
    receipt.text = (receipt.text + text).slice(-MAX_TEXT);
    receipt.progress = receipt.text.slice(-2000) || 'Qoder CLI 正在执行。';
  }

  result(record, message) {
    const receipt = record.receipt;
    if (settled(receipt.status) || receipt.status === 'finishing') return;
    const sessionId = message.session_id;
    if (typeof sessionId === 'string' && sessionId && receipt.native_session_id && sessionId !== receipt.native_session_id) {
      this.fail(record, { message: 'Qoder CLI 的 result 会话标识与 init 不一致（协议错误）。', kind: 'protocol_error' });
      return;
    }
    const subtype = message.subtype;
    if (subtype === 'success' && message.is_error !== true) {
      if (!receipt.native_session_id) {
        this.fail(record, { message: 'Qoder CLI 在未返回 init 会话标识的情况下报告成功（协议错误），不能视为完成。', kind: 'protocol_error' });
        return;
      }
      receipt.text = typeof message.result === 'string' ? message.result.slice(-MAX_TEXT) : receipt.text;
      const denials = Array.isArray(message.permission_denials)
        ? message.permission_denials.map(entry => clean(JSON.stringify(entry), 300)).filter(Boolean) : [];
      // A valid result is necessary but not sufficient: hold completion until
      // the process exits normally, so a crash after the result cannot be
      // reported as a finished task.
      receipt.status = 'finishing';
      receipt.progress = receipt.text || 'Qoder CLI 已返回结果，等待进程正常退出。';
      if (denials.length) {
        // A denied permission is a real limitation of the result, not noise:
        // keep it visible instead of showing an unqualified success.
        receipt.progress = `${receipt.progress}（${denials.length} 项权限请求被拒绝，任务结果可能受限）`;
      }
      receipt.output = {
        text: receipt.text, native_status: 'success', subtype, session_id: receipt.native_session_id,
        num_turns: message.num_turns ?? null, duration_ms: message.duration_ms ?? null,
        // Real usage is preserved verbatim (token counters may legitimately be
        // zero while credits are non-zero); nothing is recomputed here.
        usage: message.usage ?? null, total_credits: message.total_credits ?? null,
        model_usage: message.modelUsage ?? null, permission_mode: receipt.native_permission_mode ?? null,
        permission_denials: denials, permission_restricted: denials.length > 0,
        exit_confirmed: false,
      };
      this.finishGrace(record);
      return;
    }
    const errors = Array.isArray(message.errors) ? message.errors.map(value => clean(value, 300)).filter(Boolean) : [];
    const detail = errors.join('；') || clean(message.result ?? message.error ?? '', 800);
    const denials = Array.isArray(message.permission_denials)
      ? message.permission_denials.map(entry => clean(JSON.stringify(entry), 300)).filter(Boolean) : [];
    if (subtype === 'error_max_turns') {
      this.fail(record, { message: `Qoder CLI 达到轮数限制，任务未完成${detail ? `：${detail}` : '。'}`, kind: 'turn_limit', denials });
      return;
    }
    if (subtype === 'error_during_execution') {
      const auth = message.error_code === 41 || /log\s?in|auth|credential|token/i.test(detail);
      this.fail(record, {
        message: auth
          ? 'Qoder CLI 报告认证失败或未登录，任务未完成；请先在终端运行 qodercli login。'
          : `Qoder CLI 执行失败${detail ? `：${detail}` : '。'}`,
        kind: auth ? 'auth' : 'cli_error', denials,
      });
      return;
    }
    this.fail(record, { message: `Qoder CLI 返回了未知的结果类型 ${JSON.stringify(subtype)}（协议错误），不能视为完成。`, kind: 'protocol_error' });
  }

  finishGrace(record) {
    for (const [name, timer] of Object.entries(record.timers)) {
      if (name === 'cancelGrace') continue;
      clearTimeout(timer);delete record.timers[name];
    }
    // The CLI normally exits right after its result. If it does not, it is not
    // a normal end; exiting() turns that into a failure instead of success.
    record.timers.exitGrace = setTimeout(() => { void this.terminate(record); }, this.exitGraceMs);
    record.timers.exitGrace.unref?.();
  }

  settleAfterResult(record, code, signal) {
    const receipt = record.receipt;
    for (const timer of Object.values(record.timers)) clearTimeout(timer);
    record.timers = {};
    if (code === 0 && !signal) {
      receipt.status = 'completed';
      // Keep the note about denied permissions: it belongs to this result.
      receipt.progress = receipt.progress || receipt.output?.text || 'Qoder CLI 已完成任务。';
      receipt.output = { ...receipt.output, exit_code: 0, exit_confirmed: true };
      receipt.updated_at = new Date().toISOString();
      this.persist(receipt);
      return;
    }
    receipt.status = 'failed';
    receipt.error = `Qoder CLI 报告了成功结果，但随后没有正常退出（退出码 ${code ?? '未知'}${signal ? `，信号 ${signal}` : ''}），不能视为完成。`;
    receipt.progress = receipt.error;
    receipt.output = {
      ...receipt.output, native_status: 'early_exit', failure_kind: 'early_exit',
      exit_code: code ?? null, signal: signal ?? null,
    };
    receipt.updated_at = new Date().toISOString();
    this.persist(receipt);
  }

  fail(record, { message, kind, denials = [] }) {
    // Already terminated by an adapter decision such as a permission mismatch:
    // later protocol/exit errors must not replace that record.
    if (record.aborted) return;
    const receipt = record.receipt;
    if (settled(receipt.status)) {
      record.init.reject(Object.assign(new Error(message), { definite: true, output: receipt.output }));
      return;
    }
    receipt.status = 'failed';
    receipt.error = message;
    receipt.progress = message;
    receipt.output = {
      text: receipt.text.slice(-MAX_TEXT), native_status: kind, failure_kind: kind,
      session_id: receipt.native_session_id ?? null, exit_confirmed: false,
      permission_denials: denials, permission_restricted: denials.length > 0,
      ...(record.stderr.trim() ? { stderr: clean(record.stderr, 800) } : {}),
    };
    receipt.updated_at = new Date().toISOString();
    this.persist(receipt);
    const failure = Object.assign(new Error(message), { definite: true, output: structuredClone(receipt.output) });
    record.init.reject(failure);
    // Give the CLI a bounded chance to exit after a failed result.
    if (!record.exited) {
      record.timers.exitGrace = setTimeout(() => { void this.terminate(record); }, this.exitGraceMs);
      record.timers.exitGrace.unref?.();
    }
  }

  exited(record, code, signal) {
    if (record.exited) return;
    record.exited = true;
    this.flushStdout(record);
    record.exit.resolve({ code, signal });
    try { this.settleExit(record, code, signal); }
    finally { this.releaseProcess(record); }
  }

  settleExit(record, code, signal) {
    const receipt = record.receipt;
    if (record.aborted) {
      // The adapter already decided the terminal state (for example a
      // permission mismatch after delivery). A later exit code must not turn
      // that uncertain record into a completed/failed one.
      for (const [name, timer] of Object.entries(record.timers)) {
        if (name === 'cancelGrace') continue;
        clearTimeout(timer);delete record.timers[name];
      }
      return;
    }
    for (const [name, timer] of Object.entries(record.timers)) {
      if (name === 'cancelGrace') continue;
      clearTimeout(timer);delete record.timers[name];
    }
    if (receipt.status === 'finishing') {
      this.settleAfterResult(record, code, signal);
      return;
    }
    // A consumer shutdown deliberately parked this receipt as uncertain before
    // terminating the child; the resulting SIGTERM must not turn that into a
    // fabricated task failure.
    if (receipt.status === 'uncertain') return;
    if (!settled(receipt.status)) {
      if (code === 0) {
        this.fail(record, {
          message: 'Qoder CLI 在未返回合法终态 result 的情况下退出（退出码 0），不能视为完成。',
          kind: 'early_exit',
        });
      } else if (code === 130 || signal === 'SIGINT') {
        this.cancelledBySignal(record);
      } else if (code === 41) {
        this.fail(record, { message: 'Qoder CLI 认证失败（退出码 41），任务未完成；请先在终端运行 qodercli login。', kind: 'auth' });
      } else if (code === 42) {
        this.fail(record, { message: `Qoder CLI 拒绝命令行参数（退出码 42）${this.stderrHint(record)}`, kind: 'cli_error' });
      } else if (code === 44) {
        this.fail(record, { message: `Qoder CLI 沙箱错误（退出码 44）${this.stderrHint(record)}`, kind: 'cli_error' });
      } else if (code === 52) {
        this.fail(record, { message: `Qoder CLI 配置错误（退出码 52）${this.stderrHint(record)}`, kind: 'cli_error' });
      } else if (code === 53) {
        this.fail(record, { message: 'Qoder CLI 达到轮数限制（退出码 53），任务未完成。', kind: 'turn_limit' });
      } else if (code === 54) {
        this.fail(record, { message: `Qoder CLI 工具执行失败（退出码 54）${this.stderrHint(record)}`, kind: 'cli_error' });
      } else {
        this.fail(record, {
          message: `Qoder CLI 异常退出（退出码 ${code ?? '未知'}${signal ? `，信号 ${signal}` : ''}）${this.stderrHint(record)}`,
          kind: 'cli_error',
        });
      }
    }
  }

  // An exited child must not stay in the process map (nor keep its stream text
  // alive). A terminal receipt moves to the bounded body cache; the durable
  // JSON file remains the source of truth.
  releaseProcess(record) {
    if (this.processes.get(record.receipt.order_id) === record) this.processes.delete(record.receipt.order_id);
    if (!record.child || record.exited) {
      for (const timer of Object.values(record.timers)) clearTimeout(timer);
      record.timers = {};
    }
    const receipt = record.receipt;
    if (settled(receipt.status) || receipt.status === 'uncertain') {
      if (this.turns.get(receipt.order_id) === receipt) this.turns.delete(receipt.order_id);
      this.store.remember(receipt);
    }
  }

  stderrHint(record) {
    const detail = clean(record.stderr, 500);
    return detail ? `：${detail}` : '。';
  }

  cancelledBySignal(record) {
    const receipt = record.receipt;
    if (settled(receipt.status)) return;
    receipt.status = 'cancelled';
    receipt.progress = 'Qoder CLI 已中断（退出码 130），任务未完成。';
    receipt.output = { cancellation_requested: true, native_status: 'interrupted', conversation_id: receipt.conversation_id ?? null };
    for (const timer of Object.values(record.timers)) clearTimeout(timer);
    record.timers = {};
    this.persist(receipt);
  }

  executionReceipt(receipt) {
    return {
      status: receipt.status, progress: receipt.progress,
      conversation_id: receipt.conversation_id, native_session_id: receipt.native_session_id,
      route: receipt.route, directory: receipt.directory, permission: receipt.permission ?? null,
      ...(receipt.output ? { output: receipt.output } : {}),
      ...(receipt.error ? { error: receipt.error } : {}),
    };
  }

  async send(order, location, message, mode) {
    if (mode === 'steer') {
      throw Object.assign(new Error('Qoder CLI 不支持在运行中转向（steer）；请等当前回合结束后用 append 续写同一会话。'), { definite: true });
    }
    // A fast CLI may have queued its terminal save before Worker calls send().
    // Flush prior writes so a stale "starting" snapshot cannot be mistaken for
    // the current outcome (or cause a duplicate dispatch).
    await this.writes;
    let record = this.processes.get(order.id);
    let current = record?.receipt ?? this.turns.get(order.id);
    if (!current && this.store.hasOrder(order.id)) {
      current = await this.store.get(order.id);
      // A known order whose body vanished cannot be proven unsent; never turn
      // that into a fresh follow-up/duplicate dispatch.
      if (!current) throw Object.assign(new Error('Qoder 运行记录缺失，无法确认该任务是否已派发；不会自动重放。'), { deliveryUnknown: true });
    }
    if (current) {
      // A fast CLI may have already produced a terminal result (and released
      // its process record) by the time Worker calls send(). The receipt for
      // this exact order decides the outcome; it is never mistaken for a new
      // follow-up and therefore never replayed.
      if (current.status === 'completed') return this.executionReceipt(current);
      if (current.status === 'uncertain') {
        throw Object.assign(new Error(current.error ?? 'Qoder CLI 权限或会话状态未确认，未再提交消息。'), {
          deliveryUnknown: true, output: current.output ? structuredClone(current.output) : undefined,
        });
      }
      if (settled(current.status)) throw Object.assign(new Error(current.error ?? 'Qoder CLI 进程已退出，消息未提交。'), { definite: true });
      if (!record || record.exited) throw Object.assign(new Error('Qoder CLI 进程已退出，消息未提交。'), { definite: true });
    } else {
      // Follow-up work resumes from the stored native session instead of
      // creating a new conversation. The directory and route come from this
      // adapter's own receipt, never from a caller-supplied guess.
      const target = location.native_session_id ?? location.conversation_id;
      const route = location.route ?? { provider: PROVIDER, model: null };
      const receipt = {
        order_id: order.id, directory: location.directory, route,
        native_session_id: target ?? null, conversation_id: target ?? null, resume_from: target ?? null,
        // The recorded original permission is re-passed with --resume so the
        // follow-up keeps it even though every turn is a new CLI process; the
        // board is not read here.
        permission: location.permission ?? null,
        status: 'starting', progress: '正在启动 Qoder CLI 并恢复会话…', text: '',
        started_at: new Date().toISOString(),
      };
      this.turns.set(order.id, receipt);
      const catalog = await this.describe().catch(error => { throw Object.assign(error, { definite: true }); });
      // The CLI may have been upgraded/downgraded since the original turn; the
      // recorded permission still needs the running executable to declare it,
      // otherwise block before spawning instead of silently changing modes.
      if (receipt.permission) this.requirePermissionSupport(catalog, receipt.permission);
      record = this.spawnProcess(receipt, { executable: catalog.executable, resume: target ?? null });
      await this.save(receipt);
    }
    const receipt = record.receipt;
    receipt.status = 'delivering';
    receipt.progress = '已把任务写入 Qoder CLI stdin，等待会话初始化…';
    await this.save(receipt);
    try {
      record.child.stdin.write(`${message}\n`);
      record.child.stdin.end();
      record.promptWritten = true;
    } catch (error) {
      // A process that completed before this write is handled above; a write
      // failure on a still-running process leaves delivery unconfirmed.
      if (!settled(receipt.status)) {
        this.fail(record, { message: `无法向 Qoder CLI 写入任务：${clean(error.message)}`, kind: 'protocol_error' });
        throw Object.assign(new Error('无法向 Qoder CLI 写入任务，提交结果未知；不会自动重放。'), { deliveryUnknown: true });
      }
    }
    await record.init.promise;
    // Between the write and the init acknowledgement the CLI may already have
    // finished (fast model, burst output). Preserve that real state.
    if (receipt.status === 'completed') return this.executionReceipt(receipt);
    if (receipt.status === 'failed' || receipt.status === 'cancelled') {
      throw Object.assign(new Error(receipt.error ?? receipt.progress ?? 'Qoder CLI 未能完成本次任务。'), {
        definite: true, output: receipt.output ? structuredClone(receipt.output) : undefined,
      });
    }
    if (receipt.status === 'finishing') {
      // Valid success result already received; the process is exiting. Let the
      // exit path confirm the terminal state instead of forcing "executing".
      return { ...this.executionReceipt(receipt), status: 'executing', progress: receipt.progress };
    }
    receipt.status = 'executing';
    receipt.progress = 'Qoder CLI 已接收任务，正在执行。';
    await this.save(receipt);
    return {
      status: 'executing', progress: receipt.progress,
      conversation_id: receipt.conversation_id, native_session_id: receipt.native_session_id,
      route: receipt.route, directory: receipt.directory,
    };
  }

  async progress(order, state) {
    await this.writes;
    if (this.writeError) throw this.writeError;
    const receipt = this.turns.get(order.id) ?? await this.store.get(order.id);
    if (!receipt) return { status: state.status === 'uncertain' ? 'uncertain' : 'executing', progress: '未找到该任务的 Qoder 运行记录。' };
    if (receipt.status === 'completed') return { status: 'completed', progress: receipt.progress, output: receipt.output };
    if (receipt.status === 'failed') return { status: 'failed', progress: receipt.progress, output: receipt.output, error: receipt.error ?? receipt.progress };
    if (receipt.status === 'cancelled') return { status: 'cancelled', progress: receipt.progress, output: receipt.output };
    if (receipt.status === 'uncertain') return { status: 'uncertain', progress: receipt.progress, ...(receipt.output ? { output: receipt.output } : {}) };
    const record = this.processes.get(order.id);
    if (receipt.status === 'finishing') {
      if (record && !record.exited) return { status: 'executing', progress: receipt.progress };
      receipt.status = 'uncertain';
      receipt.progress = 'Qoder CLI 报告了结果，但进程终态未能确认；不会自动重放。';
      receipt.output = { ...(receipt.output ?? {}), terminal_confirmed: false, conversation_id: receipt.conversation_id ?? null };
      await this.save(receipt);
      return { status: 'uncertain', progress: receipt.progress, output: receipt.output };
    }
    if (record && !record.exited) return { status: 'executing', progress: receipt.progress };
    receipt.status = 'uncertain';
    receipt.progress = 'Qoder CLI 进程已退出且没有合法终态；结果无法确认，不会自动重放。';
    receipt.output = { text: receipt.text.slice(-MAX_TEXT), native_status: 'uncertain', terminal_confirmed: false, conversation_id: receipt.conversation_id ?? null };
    await this.save(receipt);
    return { status: 'uncertain', progress: receipt.progress, output: receipt.output };
  }

  async cancel(sessionId) {
    const live = this.liveRecordForSession(sessionId);
    const locator = this.store.session(sessionId);
    const orderId = live?.receipt.order_id ?? locator?.order_id
      ?? [...this.turns.values()].find(receipt => receipt.conversation_id === sessionId)?.order_id;
    const record = live ?? this.processes.get(orderId);
    const receipt = live?.receipt ?? record?.receipt ?? this.turns.get(orderId);
    // The session locator freezes the status seen when that alias was last
    // written; a follow-up may have completed after changing native session.
    // The order's indexed status is the current truth for cancellation.
    const status = receipt?.status ?? this.store.order(orderId)?.status ?? locator?.status;
    if (status === 'finishing') {
      return { cancelled: false, already_finishing: true, conversation_id: sessionId, native_queue_cleared: false };
    }
    if (status && settled(status)) {
      return { cancelled: false, already_terminal: true, conversation_id: sessionId, native_queue_cleared: false };
    }
    if (!record || record.exited || !record.child) {
      throw Object.assign(new Error('Qoder CLI 进程已结束或未由本消费者持有，无法取消；没有删除任何会话。'), { definite: true });
    }
    receipt.status = 'cancelled';
    receipt.progress = '已请求取消 Qoder CLI 运行中的任务。';
    receipt.output = { cancellation_requested: true, native_status: 'cancelling', conversation_id: sessionId };
    for (const [name, timer] of Object.entries(record.timers)) {
      if (name === 'cancelGrace') continue;
      clearTimeout(timer);delete record.timers[name];
    }
    await this.save(receipt);
    // Only this order's own child is signalled; other sessions (including the
    // user's own Qoder CLI runs) are never touched, and no process group is
    // signalled. A CLI that ignores SIGINT gets a bounded SIGKILL.
    void this.terminate(record, { signal: 'SIGINT', graceMs: this.cancelGraceMs });
    return {
      cancelled: true, interrupted: true, conversation_id: sessionId,
      native_queue_cleared: false, queued_messages_retained: true, local_queued_orders_retained: true,
    };
  }

  kill(record, signal) {
    const child = record?.child;
    if (!child || record.exited) return;
    try { child.kill(signal); }
    catch { /* the close/error handler reports the final state */ }
  }

  // Bounded termination for a process this adapter created: ask it to stop,
  // wait a bounded grace period, then force SIGKILL and wait again. Child
  // processes are never detached into a shared group, so this can only ever
  // affect our own child PID.
  async terminate(record, { signal = 'SIGTERM', graceMs = this.terminateGraceMs, waitMs = this.killWaitMs } = {}) {
    if (!record || record.exited || !record.child) return true;
    this.kill(record, signal);
    if (await this.waitExit(record, graceMs)) return true;
    if (record.exited) return true;
    this.kill(record, 'SIGKILL');
    return this.waitExit(record, waitMs);
  }

  waitExit(record, timeoutMs) {
    if (record.exited) return Promise.resolve(true);
    return Promise.race([
      record.exit.promise.then(() => true),
      delay(Math.max(1, timeoutMs)).then(() => false),
    ]);
  }

  async workspaceAction() {
    throw Object.assign(new Error(DSH_ONLY_WORKSPACES), { definite: true });
  }

  // Qoder CLI has no verified archive/rename/restore command in this
  // integration. Rejecting is required: deleting a session must never be used
  // to imitate an archive.
  async conversationAction(input) {
    if (input.action === 'list') {
      throw Object.assign(new Error('Qoder CLI 的会话列表格式尚未在集成中验证，暂不支持从 Agents 看板列出 Qoder 会话。'), { definite: true });
    }
    const label = input.action === 'archive' ? '归档' : input.action === 'restore' ? '恢复' : '重命名';
    throw Object.assign(new Error(`Qoder CLI 未提供经过验证的会话${label}能力；已拒绝该操作，不会删除会话冒充${label}。`), { definite: true });
  }

  save(receipt) {
    const snapshot = structuredClone(receipt);
    // The store writes the receipt body first and the index second; a failed
    // index write is recoverable from the body on the next start, while a
    // failed body write is reported to the caller instead of pretending success.
    this.writes = this.writes.then(() => this.store.commit(snapshot))
      .catch(error => { this.writeError = error; });
    return this.writes.then(() => { if (this.writeError) throw this.writeError; });
  }

  // Progress updates do not need to await the write; a later progress() call
  // awaits this chain, so ordering is preserved without blocking the stream.
  persist(receipt) {
    this.save(receipt).catch(() => {});
  }

  async close() {
    this.catalogController?.abort();
    await this.writes;
    const live = [...this.processes.values()].filter(record => !record.exited && record.child);
    for (const record of live) {
      for (const timer of Object.values(record.timers)) clearTimeout(timer);
      record.timers = {};
      const receipt = record.receipt;
      if (!settled(receipt.status) && !record.aborted) {
        if (receipt.status === 'finishing') {
          receipt.status = 'uncertain';
          receipt.progress = '已收到 Qoder CLI 的成功结果，但消费者在进程正常退出前停止，终态未完整确认。';
        } else {
          receipt.status = 'uncertain';
          receipt.progress = '消费者停止时 Qoder CLI 仍在运行；任务结果未确认，不会自动重放。';
        }
        await this.save(receipt);
      }
    }
    // Wait for every child actually to exit (TERM -> grace -> KILL), so a
    // restart cannot inherit a running CLI from a closed consumer.
    await Promise.all(live.map(record => this.terminate(record)));
    await this.writes;
    this.turns.clear();
    this.processes.clear();
    this.store.close();
  }
}

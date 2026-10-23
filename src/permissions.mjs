// Per-executor new-session permission metadata shared by the backend modules.
//
// DSH keeps its own self-contained copy in desktop.mjs because the installed
// DSH runtime snapshot may only import the files under .local/dsh-runtime-*/
// (see prepareDshExtension in command.mjs). This module is backend-only (the
// spawned-CLI adapters, delegation, MCP and tests use it); the only import is
// desktop.mjs for the DSH preset names, and desktop.mjs imports nothing from
// here, so the installed DSH snapshot is unaffected.
//
// A stored value is always a native identifier chosen from a fixed enum. The
// board's empty value means "do not touch the native default", never a made-up
// preset.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DSH_PERMISSION_PRESETS } from './desktop.mjs';

export const PERMISSION_FIELDS = Object.freeze({
  dsh: 'dsh_permission',
  hermes: 'hermes_permission',
  qoder: 'qoder_permission',
});

export const permissionField = executor => PERMISSION_FIELDS[executor] ?? null;

// Qoder CLI 1.1.78 really accepts these snake_case values. --help does not
// declare a plan mode, so none is offered or stored. The CLI reports them back
// in camelCase inside system/init, hence the alias table below.
export const QODER_PERMISSION_MODES = Object.freeze([
  'accept_edits', 'dont_ask', 'auto', 'bypass_permissions',
]);

const QODER_PERMISSION_ALIASES = Object.freeze({
  accept_edits: 'accept_edits',
  acceptEdits: 'accept_edits',
  bypass_permissions: 'bypass_permissions',
  bypassPermissions: 'bypass_permissions',
  dont_ask: 'dont_ask',
  dontAsk: 'dont_ask',
  auto: 'auto',
  default: 'default',
});

// Returns the canonical mode for a value reported by Qoder's native init, or
// null when the value is not a recognized alias. A wrong-init comparison must
// reject, never silently pass because spelling differs between the flag and the
// reported metadata.
export function normalizeQoderPermission(value) {
  return typeof value === 'string' ? QODER_PERMISSION_ALIASES[value.trim()] ?? null : null;
}

// Hermes CN desktop has no general session-level permission-mode setter. Its
// only session-scoped native control is the approval bypass flag written by
// config.set {key:"yolo", session_id, value:"1"}. The persistent approvals.mode
// values (manual/smart/off) are global config; the board neither reads nor
// writes them, so the default option must not claim which of them is active.
export const HERMES_PERMISSION_MODES = Object.freeze(['yolo']);

const NATIVE_VALUES = Object.freeze({
  dsh: DSH_PERMISSION_PRESETS,
  hermes: HERMES_PERMISSION_MODES,
  qoder: QODER_PERMISSION_MODES,
});

// Read one executor's saved new-session permission directly. Adapters use this
// so a dispatched session follows the user's stored choice; returning null
// means "omit the native control and follow the default", never "pick one".
// A manually damaged or unknown stored value is an explicit failure: dispatch
// stops instead of silently starting with another permission.
export async function readExecutorPermission(home, executor) {
  const field = permissionField(executor);
  if (!field || !home) return null;
  let text;
  try { text = await readFile(join(home, 'delegation.json'), 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`自动派工设置无法读取，无法确认新会话权限，已阻止派工：${error.message}`);
  }
  let setting;
  try { setting = JSON.parse(text); }
  catch { throw new Error('自动派工设置无法解析，无法确认新会话权限，已阻止派工。请在看板重新保存设置。'); }
  const value = setting?.[field];
  if (value === undefined) return null;
  const allowed = NATIVE_VALUES[executor] ?? [];
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`新会话权限设置值不受支持：${JSON.stringify(value)}。已阻止 ${permissionExecutorLabel(executor)} 派工，请在看板重新选择。`);
  }
  return value;
}


// Short, user-facing effect lines. Protocol details (flag names, init aliases,
// trust-directory fallback) belong in the README, not in the compact board help.
const QODER_OPTIONS = Object.freeze([
  { value: 'accept_edits', label: '自动接受安全编辑', description: '自动批准安全编辑；不覆盖命令，也不是沙箱。' },
  { value: 'dont_ask', label: '需确认即拒绝', description: '需要确认的操作直接拒绝。' },
  { value: 'auto', label: '由 Qoder 判断', description: '由 Qoder 按风险决定执行或询问。' },
  { value: 'bypass_permissions', label: '跳过权限审批', description: '跳过权限审批，风险最高；不是沙箱。' },
]);

const HERMES_OPTIONS = Object.freeze([
  { value: 'yolo', label: '跳过审批（会话级 YOLO）', description: '跳过危险命令审批；不是沙箱。' },
]);

const EXECUTOR_META = Object.freeze({
  hermes: {
    label: 'Hermes',
    defaultLabel: '跟随 Hermes 默认',
    defaultDescription: '不修改会话审批状态。',
    options: HERMES_OPTIONS,
    limitations: Object.freeze([
      '仅新会话生效；已有任务沿用原权限。',
      '不修改全局审批设置，也不提供文件系统沙箱。',
    ]),
  },
  qoder: {
    label: 'Qoder',
    defaultLabel: '跟随 Qoder 默认',
    defaultDescription: '使用 Qoder 原生默认权限。',
    options: QODER_OPTIONS,
    limitations: Object.freeze([
      '仅新会话生效；已有任务沿用原权限。',
      '不是文件系统沙箱；未信任目录会回退默认权限。',
    ]),
  },
});

const EXECUTOR_LABELS = Object.freeze({ dsh: 'DSH', hermes: 'Hermes', qoder: 'Qoder' });
export const permissionExecutorLabel = executor => EXECUTOR_LABELS[executor] ?? String(executor ?? '');

export function permissionOptions(executor) {
  return EXECUTOR_META[executor]?.options ?? [];
}

export function permissionValueName(executor, value) {
  const option = permissionOptions(executor).find(entry => entry.value === value);
  return option?.label ?? value;
}

// Build the heartbeat/board contract for a spawned-CLI executor. `nativeValues`
// is what the running executable actually advertised; only that intersection is
// offered. A caller that could not verify anything passes an empty list, which
// the board renders as "unsupported" instead of inventing options.
export function permissionControl(executor, nativeValues, { available = undefined, reason = '' } = {}) {
  const meta = EXECUTOR_META[executor];
  if (!meta) throw new Error(`Unknown permission executor: ${executor}`);
  const offered = new Set(Array.isArray(nativeValues) ? nativeValues : []);
  const options = meta.options.filter(option => offered.has(option.value));
  return {
    available: available ?? options.length > 0,
    presets: options.map(option => option.value),
    scope: 'new_session',
    default: { value: '', label: meta.defaultLabel, description: meta.defaultDescription },
    options,
    limitations: [...meta.limitations, ...(reason ? [reason] : [])],
  };
}

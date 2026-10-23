import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { monitorSnapshot } from './monitor.mjs';
import { EXECUTORS } from './executors.mjs';
import { delegationInputSchema, saveDelegation, readDelegation } from './delegation.mjs';
import { saveUsageSetting } from './usage.mjs';

export const PANEL_URI = 'ui://codex-to-agents/board/v3';
// Old board pages predate the workspace fence: they send document actions with
// a code `directory` and no workspace_id. Such a request has no root identity,
// so it cannot be upgraded or executed safely (another board may already have
// switched workspaces). Reject it at the boundary with one readable message
// before touching storage or loading the SDD module.
const LEGACY_BOARD_ACTIONS = new Set(['list_projects', 'register_project', 'list_tasks', 'create_task', 'read_task', 'save_task']);
const LEGACY_BOARD_MESSAGE = '看板页面版本过旧，缺少工作区标识，无法执行文档操作。请关闭看板页面并重新打开以载入新版本。';
const mimeType = 'text/html;profile=mcp-app';
const ui = { prefersBorder: false, csp: {} };
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const sddProjectId = z.string().regex(/^[a-f0-9]{16}$/, '项目编号无效。');
const sddTaskId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '任务编号无效。');
const sddWorkspaceId = z.string().regex(/^[a-f0-9]{16}$/, 'SDD 工作区标识无效，请重新读取工作区。');
const sddTitle = z.string().trim().min(1).max(120);
// The MCP SDK only publishes a JSON schema for object-shaped tool inputs. Keep
// the public contract as a strict object and let the dynamically imported
// sdd-workspace.mjs enforce the per-action discriminated union (required fields,
// unknown keys, workspace fencing, path/ID formats) inside the handler.
const sddSchema = z.object({
  action: z.enum(['get_workspace', 'set_workspace', 'set_enabled', 'list_projects', 'register_project',
    'list_tasks', 'create_task', 'read_task', 'save_task']),
  workspace_id: sddWorkspaceId.optional(),
  project_id: sddProjectId.optional(),
  task_id: sddTaskId.optional(),
  directory: z.string().trim().min(1).max(4096).optional(),
  // Board-only switch. The model-facing sdd_task has no such action.
  enabled: z.boolean().optional(),
  name: z.string().trim().min(1).max(120).optional(),
  title: sddTitle.optional(),
  content: z.string().optional(),
  revision: z.string().regex(/^[a-f0-9]{64}$/, '文档版本无效，请重新读取。').optional(),
}).strict();

// The plugin updater is a separate module owned by the update backend. The
// board forwards an action and the user-selected auto-update boolean; the server resolves the
// installation directory, the verified project remote and the command itself.
const updateSchema = z.object({ action: z.enum(['status', 'check', 'apply', 'check_daily', 'set_auto']), enabled: z.boolean().optional() }).strict();
const UPDATE_STATUSES = new Set(['idle', 'checking', 'up_to_date', 'available', 'blocked', 'updating', 'updated', 'failed']);
const UPDATE_DESCRIPTION = 'Read, check or install updates for the local codex-to-agents plugin installation. status reads the cached local state without network access; check contacts the verified project remote; check_daily checks at most once per 24 hours across boards and may install when the user enabled auto updates; set_auto saves the user-selected enabled boolean (default off); apply installs a fast-forward update of the verified default branch while the installation is clean and idle. Accepts action and enabled only for set_auto, never a path, URL or command. App-only; the model cannot see or call it.';

let builtHtml;
export async function panelHtml() {
  return builtHtml ??= buildHtml();
}

async function buildHtml() {
  const [html, bridge, client, sdd] = await Promise.all(['monitor.html', 'panel-bridge.js', 'monitor-client.js', 'sdd-client.js']
    .map(name => readFile(new URL(name, import.meta.url), 'utf8')));
  const script = (bridge + '\n' + client + '\n' + sdd).replace(/<\/script/gi, '<\\/script');
  return html.replace('<script src="/monitor-client.js" defer></script>', `<script defer>${script}</script>`)
    .replace('<script src="/sdd-client.js" defer></script>', '')
    .replace('<script defer>', '<script type="module">');
}

export function registerPanel(server, home, { snapshot = () => monitorSnapshot(home), onSettings, onRuntime, onPanel, onUsage, runUpdate } = {}) {
  server.registerResource('agents-board', PANEL_URI, { title: 'Agents 看板', mimeType, _meta: { ui } }, async () => ({
    contents: [{ uri: PANEL_URI, mimeType, text: await panelHtml(), _meta: {
      ui, 'openai/ui': { availableDisplayModes: ['fullscreen'], preferredDisplayMode: 'fullscreen' },
    } }],
  }));
  server.registerTool('open_panel', {
    title: 'Agents 看板', description: 'Open the Agents board inside Codex to choose the execution agent, its available model and the automatic delegation switch.',
    inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: PANEL_URI }, 'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } },
  }, async () => ({ content: [{ type: 'text', text: 'Agents 看板已打开。自动派工由看板中的开关控制。' }] }));
  for (const [name, description, schema, action] of [
    ['panel_snapshot', 'Read delegation preferences and available executor models. refresh_models loads the selected executor runtime without submitting work.',
      z.object({ executor: z.enum(EXECUTORS).optional(), refresh_models: z.boolean().optional() }).strict(), async ({ executor, refresh_models }) => {
        Promise.resolve(onPanel?.()).catch(error => console.error(error.message));
        if (refresh_models) {
          // Keep the switch usable while a disconnected executor is starting.
          Promise.resolve(onRuntime?.(executor ?? (await readDelegation(home)).executor))
            .catch(error => console.error(error.message));
        }
        return snapshot();
      }],
    ['panel_settings', 'Save the automatic delegation preference selected by the user in the Agents board. Does not submit or cancel work.', delegationInputSchema, async input => { const value = await saveDelegation(home, input);onSettings?.();return value; }],
  ]) {
    server.registerTool(name, { description, inputSchema: schema,
      annotations: { readOnlyHint: name === 'panel_snapshot', destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: PANEL_URI, visibility: ['app'] } },
    }, async input => {
      try { return result(await action(input)); }
      catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
    });
  }
  server.registerTool('panel_usage', {
    title: '匿名使用统计',
    description: 'Save the anonymous usage-statistics consent selected by the user in the Agents board. Disabled by default. Accepts only enabled; does not change delegation or SDD. App-only.',
    inputSchema: z.object({ enabled: z.boolean() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    _meta: { ui: { resourceUri: PANEL_URI, visibility: ['app'] } },
  }, async ({ enabled }) => {
    try {
      const value = await saveUsageSetting(home, enabled);
      onUsage?.(enabled);onSettings?.();
      return result(value);
    } catch { return { isError: true, content: [{ type: 'text', text: '统计设置保存失败，请重试。' }] }; }
  });
  // App-only SDD workspace. This is the board's write path for a shared
  // document directory (home/sdd by default), its task.md files, and the SDD
  // on/off switch; the read-only HTTP monitor never exposes it. Loading
  // sdd-workspace.mjs is deferred until the user's first workspace/document
  // action. Reads and writes both honor the saved switch; only set_enabled
  // changes it and no model-visible tool can.
  server.registerTool('panel_sdd', {
    title: 'SDD 共享工作区',
    description: 'Read or change the shared SDD document workspace and its independent on/off switch selected by the user in the Agents board, and read or save one task.md inside it. get_workspace reports enabled; set_enabled is app-only; when off, register_project/create_task/save_task are refused. App-only; the model cannot see or call it.',
    inputSchema: sddSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: PANEL_URI, visibility: ['app'] } },
  }, async input => {
    if (LEGACY_BOARD_ACTIONS.has(input.action) && input.workspace_id == null) {
      return { isError: true, content: [{ type: 'text', text: LEGACY_BOARD_MESSAGE }] };
    }
    try {
      const { runSddAction } = await import('./sdd-workspace.mjs');
      return result(await runSddAction(home, input));
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
  // App-only plugin updater. The update backend is imported for the board's
  // first-visible daily check or an update-card action. Reading a snapshot or
  // saving delegation alone never loads update/git code. The server owns the installation directory, the verified project
  // remote and the update command. This tool is registered on the panel-only
  // MCP surface, never in the model tool catalog.
  server.registerTool('panel_update', {
    title: '插件更新',
    description: UPDATE_DESCRIPTION,
    inputSchema: updateSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    _meta: { ui: { resourceUri: PANEL_URI, visibility: ['app'] } },
  }, async input => {
    try {
      const update = runUpdate ?? (async (root, input) => (await import('./plugin-update.mjs')).runPluginUpdate(root, input));
      const value = await (await import('./update-reminder.mjs')).runBoardUpdate(home, input, update);
      if (!value || typeof value !== 'object' || !UPDATE_STATUSES.has(value.status)) {
        throw new Error('更新状态无效，请稍后重试。');
      }
      return result(value);
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
}

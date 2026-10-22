import { z } from 'zod';

// Model-facing SDD documents. This module is intentionally lightweight: it only
// publishes the public object schema. The storage module (with its path, size,
// lock and revision checks) is loaded on the first document action.
export const SDD_TASK_NAME = 'sdd_task';
export const SDD_TASK_ACTIONS = [
  'get_workspace', 'list_projects', 'register_project',
  'list_tasks', 'create_task', 'read_task', 'save_task',
];

const sddProjectId = z.string().regex(/^[a-f0-9]{16}$/, '项目编号无效。');
const sddTaskId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '任务编号无效。');
const sddWorkspaceId = z.string().regex(/^[a-f0-9]{16}$/, 'SDD 工作区标识无效，请重新读取工作区。');
const sddRevision = z.string().regex(/^[a-f0-9]{64}$/, '文档版本无效，请重新读取。');

// The MCP SDK only publishes a JSON schema for an object root. Keep that root
// strict and let the storage layer's discriminated union enforce which fields
// each action accepts. There is deliberately no set_workspace and no
// set_enabled action and no directory/root field: only the user's board selects
// the document root and the SDD switch.
export const sddTaskSchema = z.object({
  action: z.enum(SDD_TASK_ACTIONS).describe('Document action. Use get_workspace before any other action and reuse its workspace_id.'),
  workspace_id: sddWorkspaceId.optional().describe('Workspace identifier returned by get_workspace. Required for every action except get_workspace; this tool cannot change the workspace.'),
  project_id: sddProjectId.optional().describe('Project classification ID returned by register_project or list_projects.'),
  task_id: sddTaskId.optional().describe('Task UUID returned by create_task or list_tasks.'),
  name: z.string().trim().min(1).max(120).optional().describe('Project name for register_project. Register by name; reuse the existing classification and never use a code path.'),
  title: z.string().trim().min(1).max(120).optional().describe('Optional title for the legacy board template. Ignored when create_task supplies content.'),
  content: z.string().optional().describe('Complete Markdown body. Required and non-empty for create_task: include the goal, scope, plan and acceptance criteria; the board template is not written. Required with the latest revision for save_task. At most 256 KiB.'),
  revision: sddRevision.optional().describe('Revision returned by the latest read_task. save_task rejects a stale revision and leaves the document unchanged.'),
}).strict();

const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const failure = text => ({ isError: true, content: [{ type: 'text', text }] });

const description = 'Read or update task documents in the SDD workspace selected by the user in the Agents board. This tool cannot choose or change the document root or the SDD switch. Use get_workspace first (it also reports whether SDD is enabled), then list_projects/register_project (classify by project name, never a code path), create_task with a complete non-empty Markdown plan, read_task, and save_task with the latest revision. When the user turns SDD off, register_project/create_task/save_task are rejected; reads still work and existing files are kept. Only save documents for explicit development tasks or executable plans; ordinary questions and discussion need no document. Saving a document never submits work, changes the delegation switch, or changes the execution working directory.';

export function registerSddTask(server, home) {
  server.registerTool(SDD_TASK_NAME, {
    description,
    inputSchema: sddTaskSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async input => {
    try {
      const { runSddAction, MAX_DOC_BYTES } = await import('./sdd-workspace.mjs');
      // The JSON schema cannot express per-action required fields without
      // publishing a union root, so create_task's full body is enforced here
      // before any storage call or folder creation.
      if (input.action === 'create_task') {
        if (typeof input.content !== 'string' || !input.content.trim()) {
          return failure('sdd_task 的 create_task 必须提供完整非空 content（目标、范围、计划、验收条件），不能只创建看板模板占位。');
        }
        if (Buffer.byteLength(input.content, 'utf8') > MAX_DOC_BYTES) {
          return failure('任务文档超过 256 KiB 上限。');
        }
      }
      return result(await runSddAction(home, input));
    } catch (error) { return failure(error.message); }
  });
}

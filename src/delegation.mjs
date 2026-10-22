import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { OrderBook } from './orders.mjs';

export const delegationSchema = z.object({
  enabled: z.boolean(), executor: z.enum(['hermes', 'dsh']),
  route: z.object({ provider: z.string().trim().min(1), model: z.string().trim().min(1) }).strict().optional(),
  // A fixed thinking effort only makes sense for a fixed route: the value is
  // validated against that model's catalog efforts. Omitting it follows the
  // model's own default instead of pinning a stale strength.
  effort: z.string().trim().min(1).optional(),
}).strict();
const storedSchema = delegationSchema.extend({ updated_at: z.string().datetime().optional() });

export async function readDelegation(home) {
  try { return storedSchema.parse(JSON.parse(await readFile(join(home, 'delegation.json'), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return { enabled: false, executor: 'hermes' };throw error; }
}

export async function saveDelegation(home, input) {
  const parsed = delegationSchema.parse(input);
  // "default" means "do not pin a strength"; store no effort at all so the
  // hook and work_submit omit it and the model default applies.
  if (parsed.effort === 'default') delete parsed.effort;
  if (!parsed.route && parsed.effort) throw new Error('思考强度需要与固定模型一起保存。');
  const value = { ...parsed, updated_at: new Date().toISOString() };
  const book = new OrderBook(home);await book.open();
  if (value.route) {
    let previous;
    try { previous = await readDelegation(home); } catch { /* A valid save can repair corrupt preferences. */ }
    // Model and effort form one pinned selection: changing either needs a live
    // catalog check, while closing an already-valid fixed route still works
    // offline. Disabling never requires the executor to be connected.
    const sameSelection = previous?.executor === value.executor
      && previous.route?.provider === value.route.provider
      && previous.route?.model === value.route.model
      && (previous.effort ?? null) === (value.effort ?? null);
    if (!sameSelection || (value.enabled && !previous?.enabled)) {
      const runtime = await book.runtime(null, value.executor);
      if (!runtime.online) {
        throw new Error('执行端未连接，请连接后选择模型。');
      }
      if (runtime.snapshot.catalog?.error) {
        throw new Error('模型目录暂时不可用，请稍后重试。');
      }
      const model = runtime.snapshot.catalog?.models?.find(entry => entry.provider === value.route.provider && entry.model === value.route.model);
      if (!model) {
        throw new Error('所选模型当前不可用，请重新选择。');
      }
      if (value.effort) {
        // Only catalog-provided values are real options. A model whose directory
        // entry has no efforts list (for example Hermes today) accepts none.
        const efforts = Array.isArray(model.efforts) ? model.efforts : [];
        if (!efforts.includes(value.effort)) throw new Error('所选思考强度当前不可用，请重新选择。');
      }
    }
  }
  await book.atomic(join(home, 'delegation.json'), value);
  return value;
}

// The hook only supplies the user's current preference. It never submits work,
// changes permissions, or edits either switch. An OFF message supersedes prior
// ON context in the same chat without cancelling work already accepted by an
// agent. The SDD switch is read fresh on every prompt, exactly like the
// delegation switch, so turning it off overrides document instructions that an
// earlier message already injected.
const OFF_DELEGATION = 'codex-to-agents 自动派工开关当前为关闭。这取代本会话之前的自动派工偏好：不要主动通过 codex-to-agents 派发新任务，用户明确要求调用某个 agent 时仍可调用；已提交的任务继续跟进。不要自行修改开关。';
const UNREADABLE_DELEGATION = 'codex-to-agents 自动派工配置无法读取：本轮按关闭处理，不沿用之前的开启状态；用户明确指定 agent 的请求仍按其要求处理。';
const OFF_DOCUMENTS = '本轮不要创建或更新任务文档。';

async function currentSddState(home) {
  try {
    const { readSddState } = await import('./sdd-workspace.mjs');
    return await readSddState(home);
  } catch (error) { return { enabled: false, error: error.message }; }
}

function sddClosedMessage(sdd) {
  // A damaged settings file is treated as OFF (never as the legacy ON default),
  // so an unreadable switch can never produce automatic document writes.
  return sdd.error ? 'SDD 任务文档配置无法读取，本轮按关闭处理，不会自动写入文档'
    : 'SDD 任务文档开关当前为关闭';
}

export async function delegationContext(home) {
  let setting;
  try { setting = await readDelegation(home); }
  catch { return UNREADABLE_DELEGATION; }
  const sdd = await currentSddState(home);
  if (!setting.enabled) {
    if (!sdd.enabled) return `${OFF_DELEGATION} ${sddClosedMessage(sdd)}：${OFF_DOCUMENTS}`;
    return [
      OFF_DELEGATION,
      '',
      'SDD 任务文档开关当前为开启：用户明确要求开发任务规划时，可用 sdd_task 保存目标、范围、计划和验收条件，保存后直接交付规划。只保存文档不会自动派工，本轮不要主动调用 work_submit；SDD 开关只能由用户在 Agents 看板设置，不要自行修改。',
    ].join('\n');
  }
  const effortArgument = setting.route && setting.effort ? `, effort: ${JSON.stringify(setting.effort)}` : '';
  const modelArguments = setting.route
    ? `, provider: ${JSON.stringify(setting.route.provider)}, model: ${JSON.stringify(setting.route.model)}${effortArgument}` : '';
  const modelPreference = setting.route
    ? setting.effort
      ? '新建任务使用看板选定的提供方、模型和思考强度，先确认它们仍在该执行端可用目录中；不可用时说明原因，不静默替换或降级强度。'
      : '新建任务使用看板选定的提供方和模型，思考强度跟随模型默认（不显式传 effort，也不沿用本会话之前的固定强度），先确认它们仍在该执行端可用目录中；不可用时说明原因，不静默替换。'
    : '新建任务跟随执行端默认模型和思考强度，本轮不沿用本会话之前的固定模型偏好或固定强度。';
  if (!sdd.enabled) {
    // SDD OFF overrides any earlier document/path-handoff context, but the
    // dispatch path itself stays unchanged: analyze, delegate, follow up.
    return [
      `用户在 Agents 看板开启了自动派工，执行端为 ${setting.executor}。${modelPreference}${sddClosedMessage(sdd)}：这取代本会话之前要求保存任务文档的上下文，本轮跳过任务文档保存与 task.md 路径交接，不要尝试创建或更新任务文档（开关关闭时该写入会被拒绝），直接按以下要求派工。`,
      '',
      '1. 分析：先限定目录、文件范围及验收条件；尚未形成可执行规划时先完成规划。普通问答、讨论直接处理，不创建任务文档。',
      `2. 派工：需要执行时，通过 codex-to-agents 的 runtime_info 检查该执行端，使用 work_submit（executor: "${setting.executor}"${modelArguments}）委派具体工作，并在 goal 中直接写明任务、范围与验收条件，不要求 task.md 路径；用 work_inspect 跟进、独立检查文件和验证结果，后续同任务使用 work_update，沿用原会话模型。`,
      `3. 边界：用户明确表示跳过或不需要文档时遵从。不可扩大原任务权限，执行端离线或工具缺失时说明原因，不静默换端或盲目重复提交。work_submit 的 order_id 可省略并由系统生成；若自行指定，必须在首次提交前用真实 UUID 生成器（例如 crypto.randomUUID()）生成，首次提交与不确定重试沿用同一个 order_id 和完全相同的参数；不得把任务名、cw- 会话 ID 或示例占位符当作 order_id。用户明确要求自行执行或指定其他 agent、模型时遵从用户要求。每次新的自动派工前重新读取 ${JSON.stringify(join(home, 'delegation.json'))}，若已关闭则停止自动派发。不要自行修改开关。`,
    ].join('\n');
  }
  return [
    `用户在 Agents 看板开启了自动派工，执行端为 ${setting.executor}。${modelPreference}按以下阶段处理用户要求实施的编程、修复和测试任务：`,
    '',
    '1. 分析：先限定目录、文件范围及验收条件；尚未形成可执行规划时先完成规划。普通问答、讨论不创建任务文档。',
    '2. 保存：任务明确且已形成可执行规划时，调用 sdd_task 保存约定。先用 get_workspace 读取当前工作区；再用 list_projects 或 register_project 按项目名称复用分类（项目只是分类，不能把代码路径当作文档根或项目名）；最后用 create_task 以一次完整非空正文写入目标、范围、计划和验收条件，不要只建模板占位。只保存本次任务的约定，不要把任意聊天消息或内部推理全量写入，也不扫描或改写项目里的其他文档。SDD 文档根仍只由看板设置，不能由工具切换。',
    '3. 仅规划：用户只要求规划时，完成第 2 步并交付规划后即结束，不继续以下派工步骤，不调用 work_submit；只保存文档不会自动派工。',
    `4. 路径交接与派工：需要执行时，只有拿到第 2 步的真实回执后，才把返回的 task.md 绝对路径显式写进 work_submit 的 goal，并说明以该文档为任务约定；执行工作目录仍由 work_submit 的 directory 或 workspace_id 指向实际代码项目。随后通过 codex-to-agents 的 runtime_info 检查该执行端，使用 work_submit（executor: "${setting.executor}"${modelArguments}）委派具体工作，并用 work_inspect 跟进、独立检查文件和验证结果；后续同任务使用 work_update，沿用原会话模型。`,
    '5. 同一任务更新：只复用当前任务已经返回的 workspace_id、project_id、task_id，先 read_task 获取最新 revision，再 save_task 更新原文档。不能因为名称或标题相同就自行认定为同一任务。同一任务不要重复 create_task；不同任务即使同名也分别创建。',
    `6. 边界：用户明确表示跳过或不需要文档时遵从。sdd_task 缺失或保存失败时说明未保存及阻塞原因，不得假称已保存或已完成路径交接。不可扩大原任务权限，执行端离线或工具缺失时说明原因，不静默换端或盲目重复提交。work_submit 的 order_id 可省略并由系统生成；若自行指定，必须在首次提交前用真实 UUID 生成器（例如 crypto.randomUUID()）生成，首次提交与不确定重试沿用同一个 order_id 和完全相同的参数；不得把任务名、cw- 会话 ID 或示例占位符当作 order_id。用户明确要求自行执行或指定其他 agent、模型时遵从用户要求。每次新的自动派工前重新读取 ${JSON.stringify(join(home, 'delegation.json'))}，若已关闭则停止自动派发。不要自行修改开关。`,
  ].join('\n');
}

export async function runDelegationHook(home, input = process.stdin, output = process.stdout) {
  // Drain stdin: hook payload may include a long prompt, which we neither
  // persist nor need to inspect to read an explicit user-owned preference.
  for await (const _chunk of input) { /* no prompt logging */ }
  output.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit', additionalContext: await delegationContext(home),
  } }) + '\n');
}

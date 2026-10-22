import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { OrderBook } from './orders.mjs';

export const delegationSchema = z.object({
  enabled: z.boolean(), executor: z.enum(['hermes', 'dsh']),
  route: z.object({ provider: z.string().trim().min(1), model: z.string().trim().min(1) }).strict().optional(),
}).strict();
const storedSchema = delegationSchema.extend({ updated_at: z.string().datetime().optional() });

export async function readDelegation(home) {
  try { return storedSchema.parse(JSON.parse(await readFile(join(home, 'delegation.json'), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return { enabled: false, executor: 'hermes' };throw error; }
}

export async function saveDelegation(home, input) {
  const value = { ...delegationSchema.parse(input), updated_at: new Date().toISOString() };
  const book = new OrderBook(home);await book.open();
  if (value.route) {
    let previous;
    try { previous = await readDelegation(home); } catch { /* A valid save can repair corrupt preferences. */ }
    const sameRoute = previous?.executor === value.executor && previous.route?.provider === value.route.provider && previous.route?.model === value.route.model;
    if (!sameRoute || (value.enabled && !previous.enabled)) {
      const runtime = await book.runtime(null, value.executor);
      if (!runtime.online) {
        throw new Error('执行端未连接，请连接后选择模型。');
      }
      if (runtime.snapshot.catalog?.error) {
        throw new Error('模型目录暂时不可用，请稍后重试。');
      }
      if (!runtime.snapshot.catalog?.models?.some(model => model.provider === value.route.provider && model.model === value.route.model)) {
        throw new Error('所选模型当前不可用，请重新选择。');
      }
    }
  }
  await book.atomic(join(home, 'delegation.json'), value);
  return value;
}

// The hook only supplies the user's current preference. It never submits work,
// changes permissions, or edits the switch. An OFF message supersedes prior ON
// context in the same chat without cancelling work already accepted by an agent.
export async function delegationContext(home) {
  let setting;
  try { setting = await readDelegation(home); }
  catch { return 'codex-to-agents 自动派工配置无法读取：本轮按关闭处理，不沿用之前的开启状态；用户明确指定 agent 的请求仍按其要求处理。'; }
  if (!setting.enabled) return 'codex-to-agents 自动派工开关当前为关闭。这取代本会话之前的自动派工偏好：不要主动通过 codex-to-agents 派发新任务，用户明确要求调用某个 agent 时仍可调用；已提交的任务继续跟进。不要自行修改开关。';
  const modelArguments = setting.route ? `, provider: ${JSON.stringify(setting.route.provider)}, model: ${JSON.stringify(setting.route.model)}` : '';
  const modelPreference = setting.route
    ? '新建任务使用看板选定的提供方和模型，先确认它们仍在该执行端可用目录中；不可用时说明原因，不静默替换。'
    : '新建任务跟随执行端默认模型，本轮不沿用本会话之前的固定模型偏好。';
  return `用户在 Agents 看板开启了自动派工，执行端为 ${setting.executor}。${modelPreference}对用户要求实施的编程、修复和测试任务，先分析和限定目录、文件范围及验收条件，再通过 codex-to-agents 的 runtime_info 检查该执行端，使用 work_submit（executor: "${setting.executor}"${modelArguments}）委派具体工作，并用 work_inspect 跟进、独立检查文件和验证结果；后续同任务使用 work_update，沿用原会话模型。只读问答、讨论和规划直接处理；用户明确要求自行执行或指定其他 agent、模型时遵从用户要求。不可扩大原任务权限，执行端离线或工具缺失时说明原因，不静默换端或盲目重复提交。每次新的自动派工前重新读取 ${JSON.stringify(join(home, 'delegation.json'))}，若已关闭则停止自动派发。不要自行修改开关。`;
}

export async function runDelegationHook(home, input = process.stdin, output = process.stdout) {
  // Drain stdin: hook payload may include a long prompt, which we neither
  // persist nor need to inspect to read an explicit user-owned preference.
  for await (const _chunk of input) { /* no prompt logging */ }
  output.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit', additionalContext: await delegationContext(home),
  } }) + '\n');
}

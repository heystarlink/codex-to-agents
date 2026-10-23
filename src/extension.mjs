import { isAbsolute } from 'node:path';
import { Desktop } from './desktop.mjs';
import { Consumer } from './worker.mjs';

export const name = 'codex-to-agents-desktop';
export const inject = ['llm', 'agentDefaultModel', 'agents', 'sessionController', 'sessionQuery', 'workspaceRegistry', 'workspaceController'];

export async function apply(context, settings) {
  if (!isAbsolute(settings?.home ?? '') || !isAbsolute(settings?.defaultDirectory ?? '')) throw new Error('Configure absolute home and defaultDirectory paths.');
  if (!Array.isArray(settings.providers) || !settings.providers.length || settings.providers.some(id => typeof id !== 'string' || !id.trim())) throw new Error('Configure existing providers explicitly.');
  const consumer = new Consumer(settings.home, new Desktop(context, settings), {
    onError: error => context.logger.warn(`Codex to Agents: ${error.message}`),
  });
  await consumer.open();
  consumer.start();
  context.effect(() => async () => { await consumer.close(); }, 'codex-to-agents consumer');
  await consumer.tick();
}

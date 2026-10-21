import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { monitorSnapshot } from './monitor.mjs';
import { delegationSchema, saveDelegation } from './delegation.mjs';

export const PANEL_URI = 'ui://codex-to-agents/board/v1';
const mimeType = 'text/html;profile=mcp-app';
const ui = { prefersBorder: false, csp: {} };
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });

let builtHtml;
export async function panelHtml() {
  return builtHtml ??= buildHtml();
}

async function buildHtml() {
  const [html, bridge, client] = await Promise.all(['monitor.html', 'panel-bridge.js', 'monitor-client.js']
    .map(name => readFile(new URL(name, import.meta.url), 'utf8')));
  const script = (bridge + '\n' + client).replace(/<\/script/gi, '<\\/script');
  return html.replace('<script src="/monitor-client.js" defer></script>', `<script defer>${script}</script>`)
    .replace('<script defer>', '<script type="module">');
}

export function registerPanel(server, home, { snapshot = () => monitorSnapshot(home), onSettings } = {}) {
  server.registerResource('agents-board', PANEL_URI, { title: 'Agents 看板', mimeType, _meta: { ui } }, async () => ({
    contents: [{ uri: PANEL_URI, mimeType, text: await panelHtml(), _meta: {
      ui, 'openai/ui': { availableDisplayModes: ['fullscreen'], preferredDisplayMode: 'fullscreen' },
    } }],
  }));
  server.registerTool('open_panel', {
    title: 'Agents 看板', description: 'Open the Agents board inside Codex. Shows agent status, work progress and the user-controlled automatic delegation switch.',
    inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: PANEL_URI }, 'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } },
  }, async () => ({ content: [{ type: 'text', text: 'Agents 看板已打开。自动派工由看板中的开关控制。' }] }));
  for (const [name, description, schema, action] of [
    ['panel_snapshot', 'Read the Agents board snapshot.', z.object({}).strict(), snapshot],
    ['panel_settings', 'Save the automatic delegation preference selected by the user in the Agents board. Does not submit or cancel work.', delegationSchema, async input => { const value = await saveDelegation(home, input);onSettings?.();return value; }],
  ]) {
    server.registerTool(name, { description, inputSchema: schema,
      annotations: { readOnlyHint: name === 'panel_snapshot', destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: PANEL_URI, visibility: ['app'] } },
    }, async input => {
      try { return result(await action(input)); }
      catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
    });
  }
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { OrderBook, definitions, inspectOrderId } from './orders.mjs';
import { EXECUTORS } from './executors.mjs';
import { readDelegation, assertPermissionDispatchable } from './delegation.mjs';
import { registerSddTask } from './sdd-tools.mjs';
import { createRecentOrderReader } from './recent-orders.mjs';

const response = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });

export async function createMcp(home, { panelOnly = false, onOrder, onRuntime, snapshot, onSettings, onPanel, onUsage, recentOrders } = {}) {
  const book = new OrderBook(home);
  await book.open();
  const server = new McpServer({ name: 'codex-to-agents', version: '0.1.0' });
  if (panelOnly) {
    const { registerPanel } = await import('./panel.mjs');
    registerPanel(server, home, { snapshot, onSettings, onRuntime, onPanel, onUsage });
    return server;
  }
  const listing = recentOrders ?? createRecentOrderReader(home);
  if (!recentOrders) {
    // The protocol callback covers peer/transport disconnects; explicit close
    // also awaits cleanup when no transport has ever been connected.
    const onclose = server.server.onclose;
    server.server.onclose = () => {
      onclose?.();
      void listing.close().catch(error => console.error(error.message));
    };
    const close = server.close.bind(server);
    server.close = async () => {
      try { await close(); } finally { await listing.close(); }
    };
  }
  for (const [kind, definition] of Object.entries(definitions)) {
    server.registerTool(kind, {
      description: definition.text, inputSchema: definition.schema,
      annotations: { destructiveHint: definition.destructive ?? false, readOnlyHint: false, openWorldHint: true },
    }, async input => {
      try {
        // A saved new-session permission needs a running consumer that can apply it.
        // Enforce that only for genuinely new work: a retry reusing an existing
        // order_id must still reach OrderBook, which returns reused:true for the
        // same payload and rejects a changed one. Otherwise an idempotent
        // receipt would start failing after DSH goes offline or its capability
        // heartbeat changes.
        if (kind === 'work_submit') {
          const existing = input.order_id ? await book.request(input.order_id) : null;
          if (!existing) await assertPermissionDispatchable(home, input.executor ?? 'dsh');
        }
        const order = await book.submit(kind, input);onOrder?.();return response(order);
      }
      catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
    });
  }
  // Model-visible document tool. The board keeps its app-only panel_sdd tool;
  // this one reuses the same storage contract but cannot set the workspace.
  registerSddTask(server, home);
  server.registerTool('work_inspect', {
    description: 'Read a saved work order with executor, progress, conversation ID and output. Without order_id list recent work orders. Works while execution agents are offline.',
    inputSchema: z.object({ order_id: inspectOrderId, limit: z.number().int().min(1).max(50).default(10) }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ order_id, limit }) => {
    try {
      if (order_id) {
        const state = await book.inspect(order_id);
        return response({ ...state, worker: await book.runtime(null, state.executor) });
      }
      return response(await listing.list(limit));
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
  server.registerTool('runtime_info', {
    description: 'Read consumer heartbeat and cached model catalog. Select executor dsh, hermes or qoder for its snapshot; omit to see every executor under executors. online=false means its work remains saved until that consumer connects.',
    inputSchema: z.object({ executor: z.enum(EXECUTORS).optional() }).strict(), annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ executor }) => {
    if (executor !== 'dsh') await onRuntime?.(executor);
    let delegation;
    try { delegation = await readDelegation(home); }
    catch { delegation = { enabled: false, error: 'Automatic delegation settings could not be read.' }; }
    return response({ ...await (executor ? book.runtime(null, executor) : book.runtimes()), delegation });
  });
  return server;
}

export async function openMcp(home, options) {
  const server = await createMcp(home, options);
  await server.connect(new StdioServerTransport());
  return server;
}

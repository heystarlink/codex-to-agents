import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { OrderBook, definitions } from './orders.mjs';

const response = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });

export async function openMcp(home) {
  const book = new OrderBook(home);
  await book.open();
  const server = new McpServer({ name: 'codex-to-agents', version: '0.1.0' });
  for (const [kind, definition] of Object.entries(definitions)) {
    server.registerTool(kind, {
      description: definition.text, inputSchema: definition.schema,
      annotations: { destructiveHint: definition.destructive ?? false, readOnlyHint: false, openWorldHint: true },
    }, async input => {
      try { return response(await book.submit(kind, input)); }
      catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
    });
  }
  server.registerTool('work_inspect', {
    description: 'Read a saved work order with progress, conversation ID and output. Without order_id list recent work orders. Works while DSH is offline.',
    inputSchema: z.object({ order_id: z.uuid().optional(), limit: z.number().int().min(1).max(50).default(10) }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ order_id, limit }) => {
    try {
      if (order_id) return response({ ...await book.inspect(order_id), worker: await book.runtime() });
      const orders = await book.list();
      return response({ total: orders.length, orders: orders.slice(-limit).reverse().map(item => ({
        order_id: item.order_id, kind: item.kind, status: item.status, conversation_id: item.conversation_id ?? null,
        progress: item.progress?.slice(-250) ?? '', created_at: item.created_at,
      })), worker: await book.runtime() });
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
  server.registerTool('runtime_info', {
    description: 'Read DSH consumer heartbeat and its cached allowed-model catalog. online=false means submitted work will remain saved until a consumer starts.',
    inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => response(await book.runtime()));
  await server.connect(new StdioServerTransport());
  return server;
}

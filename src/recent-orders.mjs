import { OrderBook } from './orders.mjs';
import { acquireOrderIndex, releaseOrderIndex } from './order-cache.mjs';

// One reader belongs to a long-lived MCP connection or shared backend. Merely
// creating it does no I/O; only listing work acquires the resident index.
export function createRecentOrderReader(home) {
  const book = new OrderBook(home);
  let opening;let closing;let closed = false;
  const index = () => {
    if (closed) throw new Error('Recent work-order reader is closed.');
    if (!opening) {
      const attempt = acquireOrderIndex(home);
      opening = attempt;
      attempt.catch(() => { if (opening === attempt) opening = null; });
    }
    return opening;
  };
  return {
    async list(limit) {
      const current = await index();
      await current.sync();
      if (closed) throw new Error('Recent work-order reader is closed.');
      const entries = current.all();
      // Goals and outputs are never needed for this summary. Only the selected
      // page's states are read to get fresh status and the short progress tail.
      const orders = await Promise.all(entries.slice(-limit).reverse().map(async entry => {
        const state = await book.state(entry.order_id);
        return {
          order_id: entry.order_id, executor: state?.executor ?? entry.executor, kind: entry.kind,
          status: state?.status ?? 'queued', conversation_id: state?.conversation_id ?? null,
          progress: state?.progress?.slice(-250) ?? '', created_at: entry.created_at,
        };
      }));
      return { total: entries.length, orders, worker: await book.runtimes() };
    },
    close() {
      closed = true;
      return closing ??= (async () => {
        const acquired = await opening?.catch(() => null);
        opening = null;
        if (acquired) await releaseOrderIndex(acquired);
      })();
    },
  };
}

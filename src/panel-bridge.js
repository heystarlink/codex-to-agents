// MCP Apps 2026-01-26. Only the embedding host can resolve calls. The panel
// reads data and saves user-selected preferences through app-only MCP tools.
(() => {
  const pending = new Map();const onClose = [];let nextId = 1;let closed = false;
  const send = message => window.parent.postMessage({ jsonrpc: '2.0', ...message }, '*');
  function call(method, params) {
    if (closed) return Promise.reject(new Error('看板已关闭'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id);reject(new Error('Codex 看板连接超时')); }, 10000);
      pending.set(id, { resolve, reject, timer });send({ id, method, params });
    });
  }
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.data?.jsonrpc !== '2.0') return;
    const message = event.data;
    const waiter = pending.get(message.id);
    if (waiter) {
      clearTimeout(waiter.timer);pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));else waiter.resolve(message.result);
    } else if (message.method === 'ui/resource-teardown') {
      closed = true;
      for (const callback of onClose) callback();
      for (const item of pending.values()) { clearTimeout(item.timer);item.reject(new Error('看板已关闭')); }
      pending.clear();send({ id: message.id, result: {} });
    } else if (message.id !== undefined && message.method) {
      send({ id: message.id, error: { code: -32601, message: 'Method not supported' } });
    } else if (message.method === 'ui/notifications/host-context-changed') {
      const theme = message.params?.theme;
      if (['light', 'dark'].includes(theme)) document.documentElement.style.colorScheme = theme;
    }
  });
  const ready = (async () => {
    if (window.parent === window) throw new Error('请从 Codex 左侧的 Agents 看板入口打开');
    const host = await call('ui/initialize', {
      appInfo: { name: 'codex-to-agents-board', version: '0.1.0' },
      appCapabilities: { availableDisplayModes: ['fullscreen'] }, protocolVersion: '2026-01-26',
    });
    if (host.protocolVersion !== '2026-01-26') throw new Error('Codex 看板协议版本不兼容');
    if (['light', 'dark'].includes(host.hostContext?.theme)) document.documentElement.style.colorScheme = host.hostContext.theme;
    send({ method: 'ui/notifications/initialized', params: {} });
  })();
  // Start handling rejection immediately; individual requests still report it.
  ready.catch(() => {});
  window.agentsHost = { onClose(callback) { if (closed) callback();else onClose.push(callback); }, async call(name, args = {}) {
    await ready;
    const response = await call('tools/call', { name, arguments: args });
    if (response.isError) throw new Error(response.content?.[0]?.text ?? '看板请求失败');
    return response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text);
  } };
})();

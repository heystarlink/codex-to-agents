import { randomUUID } from 'node:crypto';

export function hermesUrl(value = 'http://127.0.0.1:9120') {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Hermes URL must be a loopback HTTP(S) origin, without credentials, path or query.');
  }
  return url.origin;
}

// The desktop exposes this same ephemeral token to its local Dashboard.
// Keep it in memory only. Never read model credentials or evaluate page scripts.
export class HermesClient {
  constructor(settings = {}, { fetch = globalThis.fetch, WebSocket = globalThis.WebSocket } = {}) {
    this.url = hermesUrl(settings.url);
    this.tokenEnv = settings.tokenEnv ?? 'HERMES_DASHBOARD_SESSION_TOKEN';
    this.timeout = settings.timeout ?? 25000;
    this.fetch = fetch;
    this.WebSocket = WebSocket;
    this.pending = new Map();
    this.closed = false;
  }

  async authenticate() {
    if (this.token) return;
    this.token = process.env[this.tokenEnv];
    if (this.token) return;
    let response;
    try { response = await this.fetch(this.url + '/', { redirect: 'error', signal: AbortSignal.timeout(this.timeout) }); }
    catch { throw new Error('Cannot reach the local Hermes Dashboard. Open Hermes or check --hermes-url.'); }
    if (!response.ok) throw new Error(`Hermes Dashboard bootstrap returned HTTP ${response.status}.`);
    const html = await response.text();
    this.token = html.match(/window\.__HERMES_SESSION_TOKEN__\s*=\s*"([^"\r\n]+)"/)?.[1];
    if (!this.token) throw new Error('Hermes did not expose a local Dashboard session token. Check its authentication mode or configure the token environment variable.');
  }

  async request(path, { method = 'GET', body } = {}) {
    await this.authenticate();
    let response;
    try {
      response = await this.fetch(this.url + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(this.timeout),
        headers: { 'X-Hermes-Session-Token': this.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new Error('Hermes HTTP connection failed.'); }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) this.disconnect();
      throw Object.assign(new Error(`Hermes API returned HTTP ${response.status}.`), { definite: true, httpStatus: response.status });
    }
    return response.json();
  }

  async connect() {
    if (this.closed) throw new Error('Hermes client is closed.');
    if (this.socket?.readyState === 1) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      await this.authenticate();
      if (this.closed) throw new Error('Hermes client is closed.');
      const url = new URL(this.url + '/api/ws');
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('token', this.token);
      const socket = new this.WebSocket(url.href);
      this.socket = socket;
      socket.addEventListener('message', event => { if (this.socket === socket) this.receive(event.data); });
      socket.addEventListener('close', () => {
        if (this.socket !== socket) return;
        this.socket = null;this.token = null;
        this.rejectPending('Hermes connection closed; inspect the original task before retrying.');
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.close();reject(new Error('Hermes WebSocket connection timed out.')); }, this.timeout);
        socket.addEventListener('open', () => { clearTimeout(timer);this.generation = randomUUID();resolve(); }, { once: true });
        socket.addEventListener('error', () => { clearTimeout(timer);reject(new Error('Hermes WebSocket connection failed.')); }, { once: true });
        socket.addEventListener('close', () => { clearTimeout(timer);reject(new Error('Hermes WebSocket authentication or connection was rejected.')); }, { once: true });
      });
    })();
    try { await this.connecting; }
    finally { this.connecting = null; }
  }

  receive(data) {
    let message;
    try { message = JSON.parse(data); }
    catch { return; }
    if (message.method === 'event') { this.onEvent?.(message.params);return; }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);clearTimeout(pending.timer);
    if (message.error) {
      const detail = String(message.error.message ?? 'request rejected').split(this.token).join('[redacted]').slice(0, 1000);
      pending.reject(Object.assign(new Error(`Hermes RPC ${message.error.code}: ${detail}`), { definite: true, rpcCode: message.error.code }));
    } else pending.resolve(message.result);
  }

  async call(method, params = {}, id = randomUUID()) {
    await this.connect();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`Hermes ${method} timed out; delivery outcome is unknown.`), { deliveryUnknown: true }));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); }
      catch {
        clearTimeout(timer);this.pending.delete(id);
        reject(Object.assign(new Error('Hermes request could not be confirmed.'), { deliveryUnknown: true }));
      }
    });
  }

  rejectPending(message) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(Object.assign(new Error(message), { deliveryUnknown: true }));
    }
    this.pending.clear();
  }

  disconnect() {
    this.rejectPending('Hermes connection closed; delivery outcome is unknown.');
    this.socket?.close();this.socket = null;this.token = null;
  }

  close() { this.closed = true;this.disconnect(); }
}

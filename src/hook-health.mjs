import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJson } from './backend-control.mjs';

const pluginId = 'agents-board@codex-to-agents-local';

// Only initialize and hooks/list are sent. Trust remains owned by Codex's hook
// review flow; this process never starts a thread or changes configuration.
export function inspectHooks(codex, cwd, { signal, timeout = 8000, launch = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = launch(codex, ['app-server'], { cwd, signal, stdio: ['pipe', 'pipe', 'ignore'] });
    const lines = createInterface({ input: child.stdout });let finished = false;
    const timer = setTimeout(() => finish(new Error('Hook inspection timed out.')), timeout);
    function finish(error, value) {
      if (finished) return;finished = true;clearTimeout(timer);lines.close();child.kill();
      if (error) reject(error);else resolve(value);
    }
    const send = value => child.stdin.write(JSON.stringify(value) + '\n');
    child.on('error', error => finish(error));
    child.stdin.on('error', error => finish(error));
    child.on('close', () => finish(new Error('Hook inspection closed before a response.')));
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (![1, 2].includes(message.id)) return;
      if (message.error) { finish(new Error('Codex could not inspect hooks.'));return; }
      if (message.id === 1) {
        send({ method: 'initialized' });
        send({ id: 2, method: 'hooks/list', params: { cwds: [cwd] } });
      } else {
        const entries = message.result?.data;
        if (!Array.isArray(entries) || entries.some(entry => !Array.isArray(entry.hooks) || entry.errors?.length)) {
          finish(new Error('Codex returned an incomplete hook list.'));return;
        }
        const hook = entries.flatMap(entry => entry.hooks).find(hook => hook.pluginId === pluginId && hook.eventName === 'userPromptSubmit');
        finish(null, hook ? { status: !hook.enabled ? 'disabled' : ['trusted', 'managed'].includes(hook.trustStatus) ? 'ready'
          : ['untrusted', 'modified'].includes(hook.trustStatus) ? hook.trustStatus : 'unknown',
          trust_status: hook.trustStatus, source_path: hook.sourcePath, command: hook.command } : { status: 'missing' });
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agents-board-health', version: '0.1.0' }, capabilities: { experimentalApi: true } } });
  });
}

export function hookHealth(home, { codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex'),
  probe = inspectHooks, now = Date.now, interval = 60000, onChange = () => {} } = {}) {
  let value = { status: 'checking', checked_at: null };let checkedAt;let signature;
  let pending;let closed = false;let controller;
  const installation = join(home, 'plugin-installation.json');
  const fingerprint = async path => {
    try { const value = await stat(path);return `${value.mtimeMs}:${value.size}`; }
    catch (error) { if (error.code === 'ENOENT') return 'absent';throw error; }
  };
  const check = () => {
    if (closed) return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
      const nextSignature = (await Promise.all([installation, join(codexHome, 'config.toml')].map(fingerprint))).join('|');
      if (checkedAt !== undefined && signature === nextSignature && now() - checkedAt < interval) return;
      signature = nextSignature;checkedAt = now();
      const installed = await readJson(installation);
      if (closed) return;
      controller = new AbortController();
      value = installed?.codex ? await probe(installed.codex, homedir(), { signal: controller.signal }) : { status: 'missing_installation' };
      value = { ...value, checked_at: new Date(now()).toISOString(), scope: 'global' };
      if (!closed) onChange();
    })().catch(() => {
      value = { status: 'unknown', checked_at: new Date(now()).toISOString(), scope: 'global' };
      if (!closed) onChange();
    }).finally(() => { pending = null;controller = null; });
    return pending;
  };
  return { snapshot: () => value, check, async close() { closed = true;controller?.abort();await pending; } };
}

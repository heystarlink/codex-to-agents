#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile, copyFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { namedNode, processName } from './processes.mjs';

const begin = '# BEGIN CODEX TO AGENTS';
const end = '# END CODEX TO AGENTS';
const entry = fileURLToPath(import.meta.url);
const extension = fileURLToPath(new URL('./extension.mjs', import.meta.url));

export function stripExtension(text) {
  const first = text.indexOf(begin);
  if (first === -1) return text;
  const last = text.indexOf(end, first);
  if (last === -1 || text.indexOf(begin, first + begin.length) !== -1 || text.indexOf(end, last + end.length) !== -1) throw new Error('Malformed codex-to-agents markers.');
  // Cordis may append other patch operations before the closing comment when
  // it saves desktop settings. Remove our node, not the entire marked region.
  const ownedId = '(?:"codex-to-agents-desktop"|\'codex-to-agents-desktop\'|codex-to-agents-desktop)';
  const item = new RegExp(`^( +)-\\s+id:\\s*${ownedId}\\s*(?:#.*)?$`);
  const ownPatch = new RegExp(`^-\\s+id:\\s*${ownedId}\\s*(?:#.*)?$`);
  const body = text.slice(first + begin.length, last).split(/(?=^- )/m).map(operation => {
    const lines = operation.split(/(?<=\n)/);
    if (ownPatch.test(lines[0]?.trimEnd() ?? '')) return '';
    if (!/^- insert:\s*(?:#.*)?$/.test(lines[0]?.trimEnd() ?? '')) return operation;
    for (let index = lines.length - 1; index > 0; index--) {
      const match = lines[index].trimEnd().match(item);
      if (!match) continue;
      let stop = index + 1;
      while (stop < lines.length) {
        const line = lines[stop];
        if (line.trim() && !line.trimStart().startsWith('#') && line.match(/^ */)[0].length <= match[1].length) break;
        stop++;
      }
      lines.splice(index, stop - index);
    }
    if (!lines.slice(1).some(line => line.trim() && !line.trimStart().startsWith('#'))) return lines.slice(1).join('');
    return lines.join('');
  }).join('');
  return text.slice(0, first) + body + text.slice(last + end.length).replace(/^\r?\n/, '');
}

export function extensionBlock(settings, module = extension) {
  return `${begin}\n- insert:\n    - id: codex-to-agents-desktop\n      name: ${JSON.stringify(module)}\n      config:\n        home: ${JSON.stringify(settings.home)}\n        defaultDirectory: ${JSON.stringify(settings.defaultDirectory)}\n        providers: ${JSON.stringify(settings.providers)}\n${end}\n`;
}

async function backup(home, files) {
  const target = join(home, 'backups', new Date().toISOString().replaceAll(':', '-'));
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const [name, path] of Object.entries(files)) {
    try { await copyFile(path, join(target, name));await chmod(join(target, name), 0o600); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}

function codex(args, executable) {
  const result = spawnSync(executable ?? 'codex', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status) throw new Error((result.stderr || result.stdout).trim());
}

async function registerMcp(home, executable) {
  const { backendConnection } = await import('./backend-control.mjs');
  const connection = await backendConnection(home, '/mcp');
  codex(['mcp', 'add', 'codex-to-agents', '--url', connection.url], executable);
  const path = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
  const text = await readFile(path, 'utf8');
  const header = /^\[mcp_servers\.(?:codex-to-agents|"codex-to-agents")\]\r?$/m;
  if (!header.test(text)) throw new Error('Codex did not save the shared MCP configuration.');
  await writeFile(path, text.replace(header, match => `${match}\nhttp_headers_helper = ${JSON.stringify(connection.http_headers_helper)}`), { mode: 0o600 });
}

async function readSettings(home) {
  try { return JSON.parse(await readFile(join(home, 'settings.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {};throw error; }
}

async function hermesSettings(options) {
  const { hermesUrl } = await import('./hermes-client.mjs');
  const providers = options.provider?.split(',').map(value => value.trim());
  if (providers?.some(value => !value)) throw new Error('Hermes provider IDs must not be empty.');
  return { url: hermesUrl(options['hermes-url']), defaultDirectory: resolve(options.directory ?? join(options.home, 'workspace')),
    ...(providers ? { providers } : {}), ...(options['hermes-token-env'] ? { tokenEnv: options['hermes-token-env'] } : {}) };
}

export async function prepareDshExtension() {
  const names = ['extension.mjs', 'desktop.mjs', 'worker.mjs', 'orders.mjs'];
  const sources = await Promise.all(names.map(name => readFile(new URL(name, import.meta.url))));
  const hash = createHash('sha256');
  sources.forEach((source, index) => { hash.update(names[index]);hash.update(source); });
  const directory = fileURLToPath(new URL(`../.local/dsh-runtime-${hash.digest('hex').slice(0, 16)}/`, import.meta.url));
  await mkdir(directory, { recursive: true });
  await Promise.all(names.map((name, index) => writeFile(join(directory, name), sources[index])));
  return join(directory, 'extension.mjs');
}

export async function install(options) {
  const { OrderBook } = await import('./orders.mjs');
  const home = resolve(options.home);
  const book = new OrderBook(home);await book.open();
  const previous = await readSettings(home);
  if (options.executor && !['dsh', 'hermes'].includes(options.executor)) throw new Error('executor must be dsh or hermes.');
  if (options.executor === 'hermes') {
    const saved = await backup(home, { 'codex.toml': join(homedir(), '.codex/config.toml'), 'settings.json': join(home, 'settings.json') });
    const settings = { ...previous };
    if (options.action === 'disable') delete settings.hermes;
    else {
      settings.hermes = await hermesSettings({ ...options, home });
      await mkdir(settings.hermes.defaultDirectory, { recursive: true });
      await registerMcp(home, options.codex);
    }
    await book.atomic(join(home, 'settings.json'), settings);
    const dsh = await book.runtime();
    return { executor: 'hermes', configured: options.action !== 'disable', backup: saved,
      mcp: 'codex-to-agents', restart_mcp_required: true, dsh_reload_required: Boolean(dsh.snapshot?.active && dsh.snapshot.protocol !== 2),
      order_history_retained: true };
  }
  const profileName = options.profile ?? 'desktop';
  if (!/^[a-z0-9_-]+$/i.test(profileName)) throw new Error('Invalid profile name.');
  const profile = join(options.dshHome ?? join(homedir(), '.dsh'), 'profiles', profileName, 'cordis.patch.yml');
  const original = await readFile(profile, 'utf8');
  const codexConfig = join(homedir(), '.codex/config.toml');
  const saved = await backup(home, { 'profile.yml': profile, 'codex.toml': codexConfig, 'settings.json': join(home, 'settings.json') });
  if (options.action === 'disable') {
    await writeFile(profile, stripExtension(original));
    if (!previous.hermes) codex(['mcp', 'remove', 'codex-to-agents'], options.codex);
    return { disabled: true, backup: saved, order_history_retained: true };
  }
  const providers = options.provider?.split(',').map(item => item.trim());
  if (!providers?.length || providers.some(item => !item)) throw new Error("Specify --provider with an existing DSH provider ID or '*'.");
  if (providers.includes('*') && providers.length !== 1) throw new Error("Use --provider '*' alone; do not mix it with provider IDs.");
  const settings = { ...previous, home, providers, defaultDirectory: resolve(options.directory ?? join(home, 'workspace')) };
  await mkdir(settings.defaultDirectory, { recursive: true });
  // A fresh content-addressed module directory also refreshes nested ESM
  // imports when Cordis reloads the plugin in an already-running desktop.
  const module = await prepareDshExtension();
  const next = stripExtension(original).trimEnd() + '\n\n' + extensionBlock(settings, module);
  await registerMcp(home, options.codex);
  await writeFile(join(home, 'settings.json'), JSON.stringify(settings, null, 2), { mode: 0o600 });
  await writeFile(profile, next);
  return { configured: true, profile, home, mcp: 'codex-to-agents', backup: saved };
}

export async function main(args = process.argv.slice(2)) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: {
    home: { type: 'string', default: join(homedir(), '.codex-to-agents') }, provider: { type: 'string' },
    directory: { type: 'string' }, profile: { type: 'string' }, 'dsh-home': { type: 'string' }, codex: { type: 'string' },
    executor: { type: 'string' }, 'hermes-url': { type: 'string' }, 'hermes-token-env': { type: 'string' },
    web: { type: 'boolean' }, once: { type: 'boolean' }, json: { type: 'boolean' }, 'panel-only': { type: 'boolean' },
    interval: { type: 'string', default: '1000' }, limit: { type: 'string', default: '30' }, port: { type: 'string', default: '18862' },
  } });
  const [command] = positionals;
  process.title = processName(command, values);
  if (command === 'serve') {
    const home = resolve(values.home);
    if (values['hermes-url']) {
      const { OrderBook } = await import('./orders.mjs');const book = new OrderBook(home);await book.open();
      await book.atomic(join(home, 'settings.json'), { ...await readSettings(home), hermes: await hermesSettings({ ...values, home }) });
    }
    const { bridgeStdio } = await import('./backend-control.mjs');
    await bridgeStdio(home, { panelOnly: values['panel-only'] });
  } else if (command === 'backend-run') {
    const { startBackend } = await import('./backend.mjs');
    let backend;
    try { backend = await startBackend(resolve(values.home)); }
    catch (error) { if (error.code === 'BACKEND_BUSY') return;throw error; }
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await backend.close();process.exit(0); });
  } else if (command === 'backend-headers') {
    const { ensureBackend, backendAuth } = await import('./backend-control.mjs');
    const home = resolve(values.home);await ensureBackend(home);console.log(JSON.stringify(await backendAuth(home)));
  } else if (command === 'backend') {
    const { ensureBackend, stopBackend, backendStatus } = await import('./backend-control.mjs');
    const home = resolve(values.home);const action = positionals[1] ?? 'status';
    if (!['start', 'stop', 'restart', 'status'].includes(action)) throw new Error('backend expects start, stop, restart or status.');
    if (['stop', 'restart'].includes(action)) await stopBackend(home);
    console.log(JSON.stringify(['start', 'restart'].includes(action) ? await ensureBackend(home) : await backendStatus(home), null, 2));
  } else if (command === 'delegation-hook') {
    const { runDelegationHook } = await import('./delegation.mjs');
    await runDelegationHook(resolve(values.home));
  } else if (command === 'plugin-install') {
    const [{ OrderBook }, { preparePlugin }] = await Promise.all([import('./orders.mjs'), import('./plugin.mjs')]);
    const home = resolve(values.home);
    const book = new OrderBook(home);await book.open();
    const saved = await backup(home, { 'codex.toml': join(homedir(), '.codex/config.toml') });
    const plugin = await preparePlugin(home);
    await registerMcp(home, values.codex);
    codex(['plugin', 'marketplace', 'add', plugin.root], values.codex);
    codex(['plugin', 'add', plugin.selector], values.codex);
    await book.atomic(join(home, 'plugin-installation.json'), { codex: values.codex ?? 'codex' });
    console.log(JSON.stringify({ installed: true, ...plugin, backup: saved, restart_codex_required: true,
      hook_trust_required: true, automatic_delegation: 'unchanged; off when not configured' }, null, 2));
  } else if (command === 'worker') {
    const { startHermesWorker } = await import('./hermes-worker.mjs');
    if (values.executor && values.executor !== 'hermes') throw new Error('Standalone worker supports --executor hermes; DSH uses its desktop plugin.');
    const home = resolve(values.home);
    const settings = await readSettings(home);
    const worker = startHermesWorker(home, values['hermes-url'] ? await hermesSettings({ ...values, home })
      : settings.hermes ?? await hermesSettings({ ...values, home }), { onError: error => console.error(error.message) });
    console.log('Hermes worker started. Ctrl+C to stop; native tasks are retained.');
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await worker.close();process.exit(0); });
  } else if (['enable', 'disable'].includes(command)) {
    console.log(JSON.stringify(await install({ ...values, dshHome: values['dsh-home'], action: command }), null, 2));
  } else if (command === 'monitor') {
    const interval = Number(values.interval);const limit = Number(values.limit);const port = Number(values.port);
    if (!Number.isInteger(interval) || interval < 250 || interval > 60000) throw new Error('--interval must be 250–60000 milliseconds.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('--limit must be 1–100.');
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be 0–65535.');
    if (values.web) {
      if (values.once || values.json) throw new Error('--web cannot be combined with --once or --json.');
      const { monitorWeb } = await import('./monitor-web.mjs');
      const dashboard = await monitorWeb(resolve(values.home), { port, limit });
      console.log(`codex-to-agents monitor: ${dashboard.url}\nRead-only · Ctrl+C to stop`);
      let closing = false;
      const stop = async () => { if (closing) return;closing = true;await dashboard.close(); };
      process.once('SIGINT', stop);process.once('SIGTERM', stop);
    } else { const { monitorTerminal } = await import('./monitor.mjs');await monitorTerminal(resolve(values.home), { once: values.once, json: values.json, interval, limit }); }
  } else if (command === 'status') {
    const { OrderBook } = await import('./orders.mjs');
    const book = new OrderBook(resolve(values.home));await book.open();
    console.log(JSON.stringify({ ...await book.runtimes(), orders: (await book.list()).length }, null, 2));
  } else console.log('Commands: serve | plugin-install | backend start|stop|restart|status | enable --provider PROVIDER | enable --executor hermes | disable [--executor hermes] | worker --executor hermes | status | monitor\nHermes: --hermes-url http://127.0.0.1:9120 --hermes-token-env VARIABLE\nMonitor: --web --port 18862 | --once | --json | --interval 1000 --limit 30\nOptions: --home DIR --directory DIR --profile desktop --dsh-home DIR --codex EXECUTABLE');
}

if (process.argv[1] && resolve(process.argv[1]) === entry) {
  await main().catch(error => { console.error(error.message);process.exitCode = 1; });
}

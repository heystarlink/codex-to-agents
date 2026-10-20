#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile, copyFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { OrderBook } from './orders.mjs';
import { openMcp } from './mcp.mjs';
import { monitorTerminal } from './monitor.mjs';
import { monitorWeb } from './monitor-web.mjs';

const begin = '# BEGIN CODEX TO AGENTS';
const end = '# END CODEX TO AGENTS';
const entry = fileURLToPath(import.meta.url);
const extension = fileURLToPath(new URL('./extension.mjs', import.meta.url));

export function stripExtension(text) {
  const first = text.indexOf(begin);
  if (first === -1) return text;
  const last = text.indexOf(end, first);
  if (last === -1 || text.indexOf(begin, first + begin.length) !== -1) throw new Error('Malformed codex-to-agents markers.');
  return text.slice(0, first) + text.slice(last + end.length).replace(/^\r?\n/, '');
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

export async function install(options) {
  const home = resolve(options.home);
  const book = new OrderBook(home);await book.open();
  const profileName = options.profile ?? 'desktop';
  if (!/^[a-z0-9_-]+$/i.test(profileName)) throw new Error('Invalid profile name.');
  const profile = join(options.dshHome ?? join(homedir(), '.dsh'), 'profiles', profileName, 'cordis.patch.yml');
  const original = await readFile(profile, 'utf8');
  const codexConfig = join(homedir(), '.codex/config.toml');
  const saved = await backup(home, { 'profile.yml': profile, 'codex.toml': codexConfig, 'settings.json': join(home, 'settings.json') });
  if (options.action === 'disable') {
    await writeFile(profile, stripExtension(original));
    codex(['mcp', 'remove', 'codex-to-agents'], options.codex);
    return { disabled: true, backup: saved, order_history_retained: true };
  }
  const providers = options.provider?.split(',').map(item => item.trim());
  if (!providers?.length || providers.some(item => !item)) throw new Error('Specify --provider with an existing DSH provider ID.');
  const settings = { home, providers, defaultDirectory: resolve(options.directory ?? join(home, 'workspace')) };
  await mkdir(settings.defaultDirectory, { recursive: true });
  const next = stripExtension(original).trimEnd() + '\n\n' + extensionBlock(settings);
  codex(['mcp', 'add', 'codex-to-agents', '--', process.execPath, entry, 'serve', '--home', home], options.codex);
  await writeFile(join(home, 'settings.json'), JSON.stringify(settings, null, 2), { mode: 0o600 });
  await writeFile(profile, next);
  return { configured: true, profile, home, mcp: 'codex-to-agents', backup: saved };
}

export async function main(args = process.argv.slice(2)) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: {
    home: { type: 'string', default: join(homedir(), '.codex-to-agents') }, provider: { type: 'string' },
    directory: { type: 'string' }, profile: { type: 'string' }, 'dsh-home': { type: 'string' }, codex: { type: 'string' },
    web: { type: 'boolean' }, once: { type: 'boolean' }, json: { type: 'boolean' },
    interval: { type: 'string', default: '1000' }, limit: { type: 'string', default: '30' }, port: { type: 'string', default: '18862' },
  } });
  const [command] = positionals;
  if (command === 'serve') {
    const server = await openMcp(resolve(values.home));
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await server.close();process.exit(0); });
  } else if (['enable', 'disable'].includes(command)) {
    console.log(JSON.stringify(await install({ ...values, dshHome: values['dsh-home'], action: command }), null, 2));
  } else if (command === 'monitor') {
    const interval = Number(values.interval);const limit = Number(values.limit);const port = Number(values.port);
    if (!Number.isInteger(interval) || interval < 250 || interval > 60000) throw new Error('--interval must be 250–60000 milliseconds.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('--limit must be 1–100.');
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be 0–65535.');
    if (values.web) {
      if (values.once || values.json) throw new Error('--web cannot be combined with --once or --json.');
      const dashboard = await monitorWeb(resolve(values.home), { port, limit });
      console.log(`codex-to-agents monitor: ${dashboard.url}\nRead-only · Ctrl+C to stop`);
      let closing = false;
      const stop = async () => { if (closing) return;closing = true;await dashboard.close(); };
      process.once('SIGINT', stop);process.once('SIGTERM', stop);
    } else await monitorTerminal(resolve(values.home), { once: values.once, json: values.json, interval, limit });
  } else if (command === 'status') {
    const book = new OrderBook(resolve(values.home));await book.open();
    console.log(JSON.stringify({ ...await book.runtime(), orders: (await book.list()).length }, null, 2));
  } else console.log('Commands: serve | enable --provider PROVIDER | disable | status | monitor\nMonitor: --web --port 18862 | --once | --json | --interval 1000 --limit 30\nOptions: --home DIR --directory DIR --profile desktop --dsh-home DIR --codex EXECUTABLE');
}

if (process.argv[1] && resolve(process.argv[1]) === entry) {
  await main().catch(error => { console.error(error.message);process.exitCode = 1; });
}

import { mkdir, stat, link, copyFile, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export function processName(command, { 'panel-only': panelOnly } = {}) {
  if (command === 'serve') return panelOnly ? 'agents-board' : 'agents-mcp';
  return { 'backend-run': 'agents-backend', 'backend-headers': 'agents-hook', worker: 'agents-hermes', monitor: 'agents-monitor', 'delegation-hook': 'agents-hook' }[command] ?? 'agents-cli';
}

// macOS Activity Monitor uses the executable name, which process.title alone
// does not reliably change. Hard-link the same Node binary under a short name:
// no extra supervisor process, no changes to the source binary or its modes.
export async function namedNode(home, name, { node = process.execPath, platform = process.platform } = {}) {
  if (!/^agents-[a-z]+$/.test(name)) throw new Error('Invalid service process name.');
  if (platform !== 'darwin') return node;
  const directory = join(resolve(home), 'bin');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, name);
  const source = await stat(node);
  let existing;
  try { existing = await stat(target); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing && (existing.dev === source.dev && existing.ino === source.ino)) return target;
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    try { await link(node, temporary); }
    catch (error) {
      if (error.code !== 'EXDEV') throw error;
      // On different volumes, request a clone and otherwise let Node copy the
      // executable unchanged. A symlink would still appear as "node" on macOS.
      await copyFile(node, temporary, constants.COPYFILE_FICLONE);
    }
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return target;
}

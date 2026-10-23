import { mkdir, open, readFile, readdir, unlink, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const UPDATE_REMINDER_INTERVAL = 24 * 60 * 60 * 1000;

// A marker per UTC day gives independent MCP processes an atomic claim (wx).
// Reading yesterday as well enforces a rolling 24 hours across midnight.
// A crash/offline attempt retains its claim; opening another board won't retry.
export async function checkDailyUpdate(home, update, { now = Date.now() } = {}) {
  const cached = await update(home, { action: 'status' });
  if (['checking', 'updating'].includes(cached.status) || cached.pending_install) return cached;
  const recent = timestamp => Number.isFinite(timestamp) && now - timestamp < UPDATE_REMINDER_INTERVAL;
  if (recent(Date.parse(cached.checked_at))) return cached;
  if (cached.status === 'updated' && recent(Date.parse(cached.updated_at ?? cached.finished_at))) return cached;

  const directory = join(home, 'update-reminders');
  const day = Math.floor(now / UPDATE_REMINDER_INTERVAL);
  for (const bucket of [day, day - 1]) {
    try {
      const marker = (await readFile(join(directory, String(bucket)), 'utf8')).trim();
      // A process may exit immediately after creating its claim. Be conservative
      // about an empty marker rather than issuing repeated offline requests.
      if (!marker || recent(Number(marker))) return cached;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let claim;
  try { claim = await open(join(directory, String(day)), 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') return update(home, { action: 'status' });
    throw error;
  }
  try { await claim.writeFile(String(now)); }
  finally { await claim.close(); }

  // Keep only today's and yesterday's markers, without deleting another
  // process's current claim. Cleanup failure must not prevent checking.
  try {
    for (const name of await readdir(directory)) {
      if (/^\d+$/.test(name) && Number(name) < day - 1) await unlink(join(directory, name));
    }
  } catch { /* Retaining an old marker is harmless. */ }
  return update(home, { action: 'check' });
}

// Only the app-only board action can save this preference. Status reads remain
// local and never install; daily checks may apply an already available update.
const AUTO_SETTINGS = 'auto-update-settings.json';
export async function autoUpdateSetting(home) {
  try {
    const value = JSON.parse(await readFile(join(home, AUTO_SETTINGS), 'utf8'));
    if (!value || typeof value.enabled !== 'boolean' || Object.keys(value).length !== 1) throw new Error('Invalid setting');
    return { auto_update: value.enabled };
  } catch (error) {
    return error.code === 'ENOENT' ? { auto_update: false }
      : { auto_update: false, auto_update_error: '自动更新配置无法读取，当前不会自动安装，请重新保存开关。' };
  }
}

async function saveAutoUpdate(home, enabled) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const temporary = join(home, `${AUTO_SETTINGS}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ enabled }) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(home, AUTO_SETTINGS));
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function runBoardUpdate(home, input, update, options) {
  const { action, enabled } = input;
  if (action === 'set_auto' ? typeof enabled !== 'boolean' : enabled !== undefined) {
    throw new Error('只有 set_auto 可以保存 enabled，且必须为布尔值。');
  }
  if (action === 'set_auto') await saveAutoUpdate(home, enabled);
  let value = action === 'check_daily' ? await checkDailyUpdate(home, update, options)
    : await update(home, { action: action === 'set_auto' ? 'status' : action });
  // Re-read after the asynchronous check so another board's OFF takes effect.
  // Reuse the updater's verified remote, dirty-worktree, idle and ff-only guards.
  let setting = await autoUpdateSetting(home);
  if (action === 'check_daily' && setting.auto_update
      && value.status === 'available' && !value.pending_install) {
    value = await update(home, { action: 'apply' });
    setting = await autoUpdateSetting(home);
  }
  return { ...value, ...setting };
}

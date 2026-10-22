import { mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

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

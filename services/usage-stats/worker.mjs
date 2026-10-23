const MAX_BODY_BYTES = 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

async function readPayload(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return { error: json(415, { error: 'json_required' }) };
  }
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) {
    return { error: json(413, { error: 'body_too_large' }) };
  }
  if (!request.body) return { error: json(400, { error: 'invalid_payload' }) };
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        return { error: json(413, { error: 'body_too_large' }) };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).length !== 2
      || !Object.hasOwn(payload, 'installation_id') || !Object.hasOwn(payload, 'version')
      || typeof payload.installation_id !== 'string' || !UUID.test(payload.installation_id)
      || typeof payload.version !== 'string' || payload.version.length > 64 || !VERSION.test(payload.version)) {
      return { error: json(400, { error: 'invalid_payload' }) };
    }
    return { payload: { installation_id: payload.installation_id.toLowerCase(), version: payload.version } };
  } catch {
    return { error: json(400, { error: 'invalid_payload' }) };
  } finally {
    reader.releaseLock();
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path !== '/health' && path !== '/v1/usage') return json(404, { error: 'not_found' });
    const method = path === '/health' ? 'GET' : 'POST';
    if (request.method !== method) return json(405, { error: 'method_not_allowed' }, { allow: method });
    if (path === '/health') {
      try {
        const result = await env.DB.prepare('SELECT 1 AS ok').first();
        if (result?.ok !== 1) return json(503, { ok: false });
        return json(200, { ok: true });
      } catch { return json(503, { ok: false }); }
    }

    const { payload, error } = await readPayload(request);
    if (error) return error;
    const day = new Date().toISOString().slice(0, 10);
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO installations (installation_id, first_day, last_day, latest_version)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (installation_id) DO UPDATE SET
            first_day = MIN(installations.first_day, excluded.first_day),
            latest_version = CASE WHEN excluded.last_day >= installations.last_day
              THEN excluded.latest_version ELSE installations.latest_version END,
            last_day = MAX(installations.last_day, excluded.last_day)`)
          .bind(payload.installation_id, day, day, payload.version),
        env.DB.prepare(`INSERT INTO daily_activity (installation_id, activity_day, version)
          VALUES (?, ?, ?)
          ON CONFLICT (installation_id, activity_day) DO UPDATE SET version = excluded.version`)
          .bind(payload.installation_id, day, payload.version),
      ]);
      return json(200, { ok: true });
    } catch { return json(503, { error: 'temporarily_unavailable' }); }
  },
};

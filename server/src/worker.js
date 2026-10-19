/* Regionfilter sync server: a shared store of X "About this account" records.
 *
 * Clients read records and add newer ones; nothing here deletes or edits
 * anything else. The owner manages the database by hand (see README.md).
 * Whether a record is still worth serving is decided here, from the
 * `settings` table, and sent to the client as `exp`.
 *
 * D1's free plan allows 50 queries per request, so each batch is one
 * statement that takes the whole batch as a single JSON parameter.
 */

const HANDLE = /^[a-z0-9_]{1,15}$/;
const MAX_LOOKUP = 100;
const MAX_UPLOAD = 200;
const MAX_BODY = 256 * 1024;
const MAX_TEXT = 100;
const EARLIEST = Date.UTC(2025, 0, 1);  // before X showed "based in" at all
const SKEW = 5 * 60e3;                  // tolerated client clock drift
const DAY = 86400e3;
const SETTINGS_TTL = 60e3;
const LAST_USED_EVERY = 3600e3;

const DEFAULT_SETTINGS = { ttl_based_in_days: 30, ttl_none_days: 7, ttl_missing_days: 1 };

const HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-max-age': '86400'
};

function json(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: HEADERS });
}

/* ------------------------------------------------------------------ auth */

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function auth(req, env, ctx) {
  const m = /^Bearer\s+(\S{16,200})$/.exec(req.headers.get('authorization') || '');
  if (!m) return null;
  const row = await env.DB
    .prepare('SELECT id, name, can_write, last_used FROM tokens WHERE token_hash = ? AND revoked = 0')
    .bind(await sha256(m[1])).first();
  if (!row) return null;
  const now = Date.now();
  if (!row.last_used || now - row.last_used > LAST_USED_EVERY) {
    ctx.waitUntil(env.DB.prepare('UPDATE tokens SET last_used = ? WHERE id = ?').bind(now, row.id).run());
  }
  return { id: row.id, name: row.name, canWrite: !!row.can_write };
}

/* -------------------------------------------------------------- settings */

let settingsCache = null;
let settingsAt = 0;

async function settings(env) {
  if (settingsCache && Date.now() - settingsAt < SETTINGS_TTL) return settingsCache;
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULT_SETTINGS };
  for (const r of results) {
    const n = Number(r.value);
    if (r.key in s && Number.isFinite(n) && n >= 0) s[r.key] = n;
  }
  settingsCache = s;
  settingsAt = Date.now();
  return s;
}

function ttlOf(row, s) {
  const days = row.missing ? s.ttl_missing_days : row.based_in ? s.ttl_based_in_days : s.ttl_none_days;
  return days * DAY;
}

/* ------------------------------------------------------------ validation */

// undefined = invalid, null = not shown.
function text(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') return undefined;
  v = v.trim();
  if (v.length > MAX_TEXT || /[\u0000-\u001f\u007f]/.test(v)) return undefined;
  return v || null;
}

function cleanRecord(r, now) {
  if (!r || typeof r !== 'object') return null;
  const h = typeof r.handle === 'string' ? r.handle.toLowerCase() : '';
  if (!HANDLE.test(h)) return null;
  const t = Number(r.ts);
  if (!Number.isFinite(t) || t < EARLIEST || t > now + SKEW) return null;
  const ts = Math.min(Math.floor(t), now);
  if (r.missing === true) return { h, b: null, s: null, a: 1, m: 1, t: ts };
  const b = text(r.basedIn), s = text(r.store);
  if (b === undefined || s === undefined) return null;
  return { h, b, s, a: r.accurate === false ? 0 : 1, m: 0, t: ts };
}

/* ---------------------------------------------------------------- routes */

async function ping(body, who, env) {
  const s = await settings(env);
  return json({ ok: true, name: who.name, canWrite: who.canWrite, ttlDays: {
    basedIn: s.ttl_based_in_days, none: s.ttl_none_days, missing: s.ttl_missing_days } });
}

async function lookup(body, who, env) {
  const list = body.handles;
  if (!Array.isArray(list) || list.length > MAX_LOOKUP) return json({ error: 'handles' }, 400);
  const handles = [];
  for (const h of list) {
    const l = typeof h === 'string' ? h.toLowerCase() : '';
    if (!HANDLE.test(l)) return json({ error: 'handles' }, 400);
    if (handles.indexOf(l) === -1) handles.push(l);
  }
  if (!handles.length) return json({ records: {} });

  const s = await settings(env);
  const { results } = await env.DB
    .prepare('SELECT handle, based_in, store, accurate, missing, ts FROM records ' +
             'WHERE handle IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(handles)).all();
  const now = Date.now();
  const records = {};
  for (const r of results) {
    const exp = r.ts + ttlOf(r, s);
    if (exp <= now) continue;
    records[r.handle] = r.missing
      ? { missing: true, ts: r.ts, exp }
      : { basedIn: r.based_in, store: r.store, accurate: !!r.accurate, ts: r.ts, exp };
  }
  return json({ records });
}

async function upload(body, who, env) {
  if (!who.canWrite) return json({ error: 'read only' }, 403);
  const list = body.records;
  if (!Array.isArray(list) || list.length > MAX_UPLOAD) return json({ error: 'records' }, 400);
  const now = Date.now();
  const byHandle = new Map();
  let rejected = 0;
  for (const r of list) {
    const row = cleanRecord(r, now);
    if (!row) { rejected++; continue; }
    const cur = byHandle.get(row.h);
    if (!cur || row.t > cur.t) byHandle.set(row.h, row);
  }
  if (!byHandle.size) return json({ stored: 0, rejected });

  // Only a newer answer replaces what's stored.
  const res = await env.DB.prepare(
    `INSERT INTO records (handle, based_in, store, accurate, missing, ts, added_by, updated_at)
     SELECT json_extract(value, '$.h'), json_extract(value, '$.b'), json_extract(value, '$.s'),
            json_extract(value, '$.a'), json_extract(value, '$.m'), json_extract(value, '$.t'), ?1, ?2
     FROM json_each(?3) WHERE true
     ON CONFLICT (handle) DO UPDATE SET
       based_in = excluded.based_in, store = excluded.store, accurate = excluded.accurate,
       missing = excluded.missing, ts = excluded.ts, added_by = excluded.added_by,
       updated_at = excluded.updated_at
     WHERE excluded.ts > records.ts`
  ).bind(who.id, now, JSON.stringify([...byHandle.values()])).run();
  return json({ stored: res.meta.changes, rejected });
}

const ROUTES = {
  'GET /v1/ping': ping,
  'POST /v1/lookup': lookup,
  'POST /v1/records': upload
};

async function readBody(req) {
  if (Number(req.headers.get('content-length') || 0) > MAX_BODY) return null;
  const raw = await req.text();
  if (raw.length > MAX_BODY) return null;
  try {
    const body = JSON.parse(raw);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch (e) {
    return null;
  }
}

async function route(req, env, ctx) {
  const path = new URL(req.url).pathname.replace(/\/+$/, '');
  const fn = ROUTES[req.method + ' ' + path];
  if (!fn) return json({ error: 'not found' }, 404);
  const who = await auth(req, env, ctx);
  if (!who) return json({ error: 'unauthorized' }, 401);
  let body = null;
  if (req.method === 'POST') {
    body = await readBody(req);
    if (!body) return json({ error: 'bad body' }, 400);
  }
  return fn(body, who, env);
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEADERS });
    try {
      return await route(req, env, ctx);
    } catch (e) {
      console.error(e);
      return json({ error: 'server' }, 500);
    }
  }
};

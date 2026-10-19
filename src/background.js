/* Location cache and lookup budget, shared by every x.com tab.
 *
 * X allows 50 About lookups per 15 minutes per account, across all tabs and
 * including the ones X makes itself when you open an About page. Tabs ask here
 * for a lease before looking anyone up, and report every response's
 * x-rate-limit-* headers back, so the budget below tracks X's own count.
 *
 * With a sync database connected (server/README.md), a cache miss asks the
 * database before it costs an X lookup, and every answer from X is uploaded.
 *
 * Firefox may unload this event page when idle. Everything that matters is
 * reloaded from storage on the next message.
 */
(function () {
  'use strict';

  var api = TBR.api;
  var R = TBR.regions;

  var DAY = 86400e3;
  var CACHE_TTL = 30 * DAY;    // a disclosed "based in" rarely changes
  var NONE_TTL = 7 * DAY;      // nothing disclosed (or only a store country)
  var MISSING_TTL = 1 * DAY;   // no such account (renamed, suspended)
  var INFLIGHT_MS = 20000;
  var UNKNOWN_BURST = 3;       // lookups to allow before X has told us the real budget
  var RESERVE = 5;             // left untouched per window, for your own About-page visits

  var state = null;            // {cache, limit, queryId, seen, syncedTo}
  var loading = null;
  var inflight = Object.create(null);   // handle -> ts
  var saveTimer = null;

  function load() {
    if (state) return Promise.resolve(state);
    if (!loading) {
      loading = api.storage.local.get(['locations', 'limit', 'queryId', 'seen', 'db', 'dbSyncedTo']).then(function (r) {
        var s = {
          cache: r.locations || {},
          limit: r.limit || null,          // {remaining, limit, reset(ms)}
          queryId: r.queryId || null,
          seen: r.seen || {},              // raw "based in" string -> count, for the options page
          syncedTo: r.dbSyncedTo || ''     // the database the cache's "up" marks refer to
        };
        return connect(s, r.db).then(function () { state = s; backfill(); return s; });
      });
    }
    return loading;
  }

  function persist() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      api.storage.local.set({ locations: state.cache, limit: state.limit, queryId: state.queryId, seen: state.seen });
    }, 1000);
  }

  /* ----------------------------------------------------------------- cache */

  // Cached as raw facts {basedIn, store, accurate, missing, ts}, so flipping a
  // source toggle takes effect at once without looking anyone up again.
  // Records from the sync database also carry src:'db' and the server's exp;
  // up:1 marks a record the database already has.
  function ttlOf(rec) {
    if (rec.missing) return MISSING_TTL;
    if (!rec.basedIn) return NONE_TTL;
    return CACHE_TTL;
  }

  function fresh(rec) {
    if (!rec) return false;
    if (rec.exp) return Date.now() < rec.exp;   // the database decides for its own records
    return Date.now() - rec.ts < ttlOf(rec);
  }

  function recordFrom(info) {
    if (!info.found) return { missing: true, ts: Date.now() };
    return { basedIn: info.basedIn || null, store: info.store || null, accurate: info.accurate !== false, ts: Date.now() };
  }

  // Raw facts -> what the matcher sees, under the current source toggles.
  function view(rec, settings) {
    if (!rec) return null;
    if (rec.missing) return { target: null, raw: '', kind: 'missing' };
    var src = settings.sources;
    if (src.basedIn && rec.basedIn) {
      var t = R.parseLocation(rec.basedIn);
      if (t && t !== 'unavailable') {
        return { target: t, raw: rec.basedIn, kind: /^[A-Z]{2}$/.test(t) ? 'country' : 'region', accurate: rec.accurate };
      }
    }
    if (src.connectedVia && rec.store) {
      var s = R.parseLocation(rec.store);
      if (s && /^[A-Z]{2}$/.test(s)) return { target: s, raw: rec.store, kind: 'appstore', accurate: rec.accurate };
    }
    return { target: 'unavailable', raw: '', kind: 'none' };
  }

  /* ---------------------------------------------------------------- budget */

  function tidy(now) {
    Object.keys(inflight).forEach(function (h) {
      if (now - inflight[h] > INFLIGHT_MS) delete inflight[h];
    });
    if (state.limit && now >= state.limit.reset) state.limit = null;
  }

  function budget() {
    var now = Date.now();
    tidy(now);
    var busy = Object.keys(inflight).length;
    if (!state.limit) return { left: UNKNOWN_BURST - busy, until: 0 };
    var left = state.limit.remaining - RESERVE - busy;
    return { left: left, until: left > 0 ? 0 : state.limit.reset };
  }

  function noteLimit(limit) {
    if (!limit || !(limit.reset > 0)) return;
    // Responses can arrive out of order; within one window the smaller
    // remaining count is the newer one.
    var cur = state.limit;
    if (!cur || limit.reset > cur.reset || limit.remaining < cur.remaining) state.limit = limit;
  }

  function lease(handles) {
    var b = budget();
    var grant = [];
    for (var i = 0; i < handles.length && grant.length < b.left; i++) {
      var h = handles[i];
      if (inflight[h] || fresh(state.cache[h])) continue;
      inflight[h] = Date.now();
      grant.push(h);
    }
    var after = budget();
    return { grant: grant, until: after.left > 0 ? 0 : (after.until || Date.now() + 5000) };
  }

  /* --------------------------------------------------------- sync database */

  // Order of a lookup: local cache, then the database, then X. The database
  // never deletes; it only gets records it lacks or newer ones.
  var DB_TIMEOUT = 1500;        // a slow database mustn't hold posts blank for long
  var DB_UPLOAD_TIMEOUT = 15000;
  var DB_MISS_MS = 5 * 60e3;    // don't ask again about a handle it didn't have
  var DB_BACKOFF = 60e3;        // after an error, leave it alone this long
  var DB_LOOKUP_MAX = 100;
  var DB_UPLOAD_MAX = 200;
  var DB_UPLOAD_DELAY = 5000;

  var db = {
    conf: null,                         // {base, token, pattern}
    allowed: false,                     // Firefox host permission for it
    miss: Object.create(null),          // handle -> ts it had nothing
    asking: Object.create(null),        // handle -> promise
    queue: Object.create(null),         // handles to upload
    timer: null,
    downUntil: 0,
    error: '',
    readOnly: false
  };

  // Takes the stored {url, token}; resolves once the permission is known.
  function connect(s, raw) {
    var base = raw && raw.token ? TBR.sync.base(raw.url) : null;
    db.conf = base ? { base: base, token: String(raw.token), pattern: TBR.sync.pattern(base) } : null;
    db.miss = Object.create(null);
    db.queue = Object.create(null);
    db.downUntil = 0;
    db.error = '';
    db.readOnly = !!(raw && raw.canWrite === false);
    if (!db.conf) { db.allowed = false; return Promise.resolve(); }
    // A different database hasn't got anything this cache uploaded elsewhere.
    if (s.syncedTo !== base) {
      Object.keys(s.cache).forEach(function (h) { delete s.cache[h].up; delete s.cache[h].src; });
      s.syncedTo = base;
      api.storage.local.set({ locations: s.cache, dbSyncedTo: base });
    }
    return checkAllowed();
  }

  function checkAllowed() {
    if (!db.conf) return Promise.resolve();
    return api.permissions.contains({ origins: [db.conf.pattern] }).then(function (ok) {
      db.allowed = ok;
      db.error = ok ? '' : 'Firefox permission for the server is missing. Connect again.';
    }, function () { db.allowed = false; });
  }

  function dbOn() {
    return !!(db.conf && db.allowed && Date.now() >= db.downUntil);
  }

  function dbFetch(path, body, timeout) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, timeout);
    return fetch(db.conf.base + path, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + db.conf.token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
      signal: ctl.signal
    }).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) {
        var e = new Error(r.status === 401 ? 'The server no longer accepts this token.' : 'Server answered HTTP ' + r.status + '.');
        e.status = r.status;
        throw e;
      }
      return r.json();
    }, function (e) {
      clearTimeout(timer);
      throw new Error(e && e.name === 'AbortError' ? 'Server took too long.' : 'Server unreachable.');
    });
  }

  function dbFail(e) {
    db.error = e.message;
    db.downUntil = Date.now() + DB_BACKOFF;
  }

  function text(v) {
    return typeof v === 'string' && v.length <= 100 ? v : null;
  }

  function fromDb(handles, got) {
    var now = Date.now();
    handles.forEach(function (h) {
      var d = got[h];
      var cur = state.cache[h];
      if (!d || !(d.exp > now) || !(d.ts > 0) || (cur && cur.ts > d.ts)) {
        db.miss[h] = now;
        return;
      }
      var rec = d.missing ? { missing: true }
        : { basedIn: text(d.basedIn), store: text(d.store), accurate: d.accurate !== false };
      rec.ts = d.ts;
      rec.exp = d.exp;
      rec.src = 'db';
      state.cache[h] = rec;
      if (rec.basedIn) state.seen[rec.basedIn] = (state.seen[rec.basedIn] || 0) + 1;
    });
    db.error = '';
    persist();
  }

  function lookupChunk(handles) {
    var p = dbFetch('/v1/lookup', { handles: handles }, DB_TIMEOUT).then(function (r) {
      fromDb(handles, (r && r.records) || {});
    }, dbFail).then(function () {
      handles.forEach(function (h) { delete db.asking[h]; });
    });
    handles.forEach(function (h) { db.asking[h] = p; });
    return p;
  }

  // Asks the database about cache misses. Never rejects; whatever it had is
  // in the cache afterwards.
  function dbLookup(handles) {
    var now = Date.now();
    var waits = [], ask = [];
    handles.forEach(function (h) {
      if (db.asking[h]) { if (waits.indexOf(db.asking[h]) === -1) waits.push(db.asking[h]); }
      else if (!(now - (db.miss[h] || 0) < DB_MISS_MS)) ask.push(h);
    });
    for (var i = 0; i < ask.length; i += DB_LOOKUP_MAX) waits.push(lookupChunk(ask.slice(i, i + DB_LOOKUP_MAX)));
    return Promise.all(waits);
  }

  function wire(h, r) {
    if (r.missing) return { handle: h, missing: true, ts: r.ts };
    return { handle: h, basedIn: r.basedIn || null, store: r.store || null, accurate: r.accurate !== false, ts: r.ts };
  }

  function uploadSoon(delay) {
    if (!db.timer && db.conf && !db.readOnly) db.timer = setTimeout(flushUploads, delay);
  }

  function queueUpload(h) {
    if (!db.conf || db.readOnly) return;
    db.queue[h] = 1;
    uploadSoon(DB_UPLOAD_DELAY);
  }

  // Everything the database hasn't got from this cache yet. Runs whenever the
  // background wakes, so uploads lost to an unload are retried.
  function backfill() {
    if (!db.conf || !db.allowed || db.readOnly) return;
    Object.keys(state.cache).forEach(function (h) {
      var r = state.cache[h];
      if (!r.src && !r.up) db.queue[h] = 1;
    });
    if (Object.keys(db.queue).length) uploadSoon(1000);
  }

  function flushUploads() {
    db.timer = null;
    if (!db.conf || !db.allowed || db.readOnly) return;
    var wait = db.downUntil - Date.now();
    if (wait > 0) { uploadSoon(wait); return; }
    var sent = {}, records = [];
    Object.keys(db.queue).slice(0, DB_UPLOAD_MAX).forEach(function (h) {
      delete db.queue[h];
      var r = state.cache[h];
      if (!r || r.src || r.up) return;
      sent[h] = r.ts;
      records.push(wire(h, r));
    });
    if (!records.length) {
      if (Object.keys(db.queue).length) uploadSoon(0);
      return;
    }
    dbFetch('/v1/records', { records: records }, DB_UPLOAD_TIMEOUT).then(function () {
      // Rejected records are marked too: sending them again wouldn't help.
      Object.keys(sent).forEach(function (h) {
        var r = state.cache[h];
        if (r && r.ts === sent[h]) r.up = 1;
      });
      db.error = '';
      persist();
      if (Object.keys(db.queue).length) uploadSoon(1000);
    }, function (e) {
      if (e.status === 403) {
        db.readOnly = true;
        db.queue = Object.create(null);
        return;
      }
      dbFail(e);
      Object.keys(sent).forEach(function (h) { db.queue[h] = 1; });
      uploadSoon(DB_BACKOFF);
    });
  }

  function dbStats() {
    if (!db.conf) return null;
    var fromDb = 0, uploaded = 0, waiting = 0;
    Object.keys(state.cache).forEach(function (h) {
      var r = state.cache[h];
      if (r.src) fromDb++;
      else if (r.up) uploaded++;
      else waiting++;
    });
    return { base: db.conf.base, allowed: db.allowed, readOnly: db.readOnly, error: db.error,
             fromDb: fromDb, uploaded: uploaded, waiting: db.readOnly ? 0 : waiting };
  }

  /* -------------------------------------------------------------- messages */

  function broadcast(msg) {
    api.tabs.query({ url: ['*://x.com/*', '*://*.x.com/*', '*://twitter.com/*', '*://*.twitter.com/*'] })
      .then(function (tabs) {
        tabs.forEach(function (t) { api.tabs.sendMessage(t.id, msg).catch(function () {}); });
      }, function () {});
  }

  function result(msg, settings) {
    var h = String(msg.handle || '').toLowerCase();
    delete inflight[h];
    noteLimit(msg.limit);
    if (msg.error === 'rate') {
      state.limit = { remaining: 0, limit: (msg.limit && msg.limit.limit) || 50,
                      reset: (msg.limit && msg.limit.reset) || Date.now() + 15 * 60e3 };
    }
    var out = { budget: budget() };
    if (msg.info && h) {
      var rec = recordFrom(msg.info);
      state.cache[h] = rec;
      queueUpload(h);
      if (msg.info.basedIn) state.seen[msg.info.basedIn] = (state.seen[msg.info.basedIn] || 0) + 1;
      var items = {};
      items[h] = view(rec, settings);
      broadcast({ type: 'updated', items: items });
    }
    persist();
    return out;
  }

  function prune() {
    var n = 0;
    Object.keys(state.cache).forEach(function (h) {
      if (!fresh(state.cache[h])) { delete state.cache[h]; n++; }
    });
    if (n) persist();
  }

  var handlers = {
    get: function (msg, s) {
      var handles = msg.handles || [];
      var misses = handles.filter(function (h) { return !fresh(state.cache[h]); });
      var asked = misses.length && dbOn() ? dbLookup(misses) : Promise.resolve();
      return asked.then(function () {
        var items = {};
        handles.forEach(function (h) {
          var rec = state.cache[h];
          items[h] = fresh(rec) ? view(rec, s) : null;
        });
        return { items: items, budget: budget(), queryId: state.queryId };
      });
    },
    lease: function (msg, s) { return lease(msg.handles || []); },
    result: function (msg, s) { return result(msg, s); },
    queryId: function (msg) {
      state.queryId = msg.id;
      persist();
      return { ok: true };
    },
    stats: function (msg, s) {
      var byKind = {};
      Object.keys(state.cache).forEach(function (h) {
        var r = state.cache[h];
        var k = r.missing ? 'missing' : r.basedIn ? 'basedIn' : r.store ? 'storeOnly' : 'none';
        byKind[k] = (byKind[k] || 0) + 1;
      });
      return { size: Object.keys(state.cache).length, byKind: byKind, budget: budget(),
               limit: state.limit, queryId: state.queryId, seen: state.seen, db: dbStats() };
    },
    dump: function () { return { cache: state.cache }; },
    clearCache: function () {
      state.cache = {};
      state.seen = {};
      db.miss = Object.create(null);
      db.queue = Object.create(null);
      persist();
      broadcast({ type: 'cleared' });
      return { ok: true };
    }
  };

  api.runtime.onMessage.addListener(function (msg, sender) {
    if (!msg || !msg.type) return;
    if (msg.type === 'badge') {
      var tab = sender.tab && sender.tab.id;
      if (tab != null) {
        api.action.setBadgeText({ tabId: tab, text: msg.count ? String(msg.count) : '' });
        api.action.setBadgeBackgroundColor({ tabId: tab, color: '#c2410c' });
      }
      return;
    }
    var fn = handlers[msg.type];
    if (!fn) return;
    return Promise.all([load(), TBR.settings.get()]).then(function (v) { return fn(msg, v[1]); });
  });

  // Connecting, disconnecting or switching servers happens on the options page.
  api.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local' || !changes.db || !state) return;
    connect(state, changes.db.newValue).then(backfill);
  });

  function permsChanged() {
    if (state) checkAllowed().then(backfill);
  }
  api.permissions.onAdded.addListener(permsChanged);
  api.permissions.onRemoved.addListener(permsChanged);

  // 1.x kept an incompatible cache and a diagnostics blob under these keys.
  api.runtime.onInstalled.addListener(function () {
    api.storage.local.remove(['cache', 'diag']);
  });

  api.runtime.onStartup.addListener(function () {
    load().then(prune);
  });
})();

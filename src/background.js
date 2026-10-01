/* Location cache and lookup budget, shared by every x.com tab.
 *
 * X allows 50 About lookups per 15 minutes per account, across all tabs and
 * including the ones X makes itself when you open an About page. Tabs ask here
 * for a lease before looking anyone up, and report every response's
 * x-rate-limit-* headers back, so the budget below tracks X's own count.
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

  var state = null;            // {cache, limit, queryId, seen}
  var inflight = Object.create(null);   // handle -> ts
  var saveTimer = null;

  function load() {
    if (state) return Promise.resolve(state);
    return api.storage.local.get(['locations', 'limit', 'queryId', 'seen']).then(function (r) {
      state = state || {
        cache: r.locations || {},
        limit: r.limit || null,          // {remaining, limit, reset(ms)}
        queryId: r.queryId || null,
        seen: r.seen || {}               // raw "based in" string -> count, for the options page
      };
      return state;
    });
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
  function ttlOf(rec) {
    if (rec.missing) return MISSING_TTL;
    if (!rec.basedIn) return NONE_TTL;
    return CACHE_TTL;
  }

  function fresh(rec) {
    return !!rec && Date.now() - rec.ts < ttlOf(rec);
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
      var items = {};
      (msg.handles || []).forEach(function (h) {
        var rec = state.cache[h];
        items[h] = fresh(rec) ? view(rec, s) : null;
      });
      return { items: items, budget: budget(), queryId: state.queryId };
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
               limit: state.limit, queryId: state.queryId, seen: state.seen };
    },
    dump: function () { return { cache: state.cache }; },
    clearCache: function () {
      state.cache = {};
      state.seen = {};
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

  // 1.x kept an incompatible cache and a diagnostics blob under these keys.
  api.runtime.onInstalled.addListener(function () {
    api.storage.local.remove(['cache', 'diag']);
  });

  api.runtime.onStartup.addListener(function () {
    load().then(prune);
  });
})();

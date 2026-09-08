/* Shared location cache + message hub.
 *
 * Lives here rather than in the content script so that a lookup done in one
 * tab immediately benefits every other tab, and survives navigation.
 */
(function () {
  'use strict';

  var api = TBR.api;
  var R = TBR.regions;

  var cache = Object.create(null);   // handle -> {target, raw, kind, source, ts, rank}
  var loaded = false;
  var dirty = false;
  var saveTimer = null;
  var badges = Object.create(null);

  function rankOf(kind, source) {
    var base = kind === 'country' ? 60 : kind === 'region' ? 50 : kind === 'self' ? 10 : 20;
    if (source === 'override') return 1000;
    if (source === 'dom-about') base += 25;
    else if (/^api-about|^api-userabout|^api-profileabout/.test(source)) base += 20;
    return base;
  }

  function load() {
    if (loaded) return Promise.resolve();
    return api.storage.local.get('cache').then(function (res) {
      cache = (res && res.cache) || Object.create(null);
      loaded = true;
    });
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      if (!dirty) return;
      dirty = false;
      api.storage.local.set({ cache: cache });
    }, 2000);
  }

  function fresh(rec, ttlMs) {
    return rec && (Date.now() - rec.ts) < ttlMs;
  }

  function put(items, settings) {
    var changed = {};
    items.forEach(function (it) {
      var handle = String(it.handle || '').toLowerCase();
      if (!handle) return;
      if (it.kind === 'self' && !settings.sources.selfReported) return;

      var target = R.parseLocation(it.raw);
      if (!target) return;

      var rank = rankOf(it.kind, it.source);
      var old = cache[handle];
      if (old && old.rank > rank && fresh(old, settings.cacheTtlHours * 3600e3)) return;
      if (old && old.rank === rank && old.target === target) { old.ts = Date.now(); return; }

      var rec = {
        target: target, raw: String(it.raw), kind: it.kind,
        source: it.source, field: it.field || '', ts: Date.now(), rank: rank
      };
      cache[handle] = rec;
      changed[handle] = rec;
    });
    if (Object.keys(changed).length) {
      scheduleSave();
      broadcast({ type: 'updated', items: changed });
    }
    return changed;
  }

  function broadcast(msg) {
    api.tabs.query({ url: ['*://x.com/*', '*://twitter.com/*', '*://mobile.x.com/*', '*://mobile.twitter.com/*'] })
      .then(function (tabs) {
        tabs.forEach(function (t) {
          api.tabs.sendMessage(t.id, msg).catch(function () { /* tab not ready */ });
        });
      }).catch(function () { /* */ });
  }

  function prune(ttlMs) {
    var now = Date.now(), n = 0;
    Object.keys(cache).forEach(function (h) {
      if (cache[h].source !== 'override' && (now - cache[h].ts) > ttlMs) { delete cache[h]; n++; }
    });
    if (n) scheduleSave();
    return n;
  }

  api.runtime.onMessage.addListener(function (msg, sender) {
    if (!msg || !msg.type) return;

    if (msg.type === 'get') {
      return load().then(function () {
        return TBR.settings.get().then(function (s) {
          var ttl = s.cacheTtlHours * 3600e3;
          var out = {};
          (msg.handles || []).forEach(function (h) {
            h = String(h).toLowerCase();
            var rec = cache[h];
            out[h] = fresh(rec, ttl) ? rec : null;
          });
          return { items: out };
        });
      });
    }

    if (msg.type === 'put') {
      return load().then(function () {
        return TBR.settings.get().then(function (s) {
          return { changed: put(msg.items || [], s) };
        });
      });
    }

    if (msg.type === 'badge') {
      var tabId = sender.tab && sender.tab.id;
      if (tabId != null) {
        badges[tabId] = msg.count | 0;
        api.action.setBadgeText({ tabId: tabId, text: msg.count ? String(msg.count) : '' });
        api.action.setBadgeBackgroundColor({ tabId: tabId, color: '#f7768e' });
      }
      return;
    }

    if (msg.type === 'cacheStats') {
      return load().then(function () {
        var byTarget = {};
        Object.keys(cache).forEach(function (h) {
          var t = cache[h].target;
          byTarget[t] = (byTarget[t] || 0) + 1;
        });
        return { size: Object.keys(cache).length, byTarget: byTarget };
      });
    }

    if (msg.type === 'cacheDump') {
      return load().then(function () { return { cache: cache }; });
    }

    if (msg.type === 'clearCache') {
      cache = Object.create(null);
      return api.storage.local.set({ cache: cache }).then(function () { return { ok: true }; });
    }

    if (msg.type === 'forget') {
      return load().then(function () {
        (msg.handles || []).forEach(function (h) { delete cache[String(h).toLowerCase()]; });
        scheduleSave();
        return { ok: true };
      });
    }
  });

  api.tabs.onRemoved.addListener(function (id) { delete badges[id]; });

  api.runtime.onInstalled.addListener(function () {
    load().then(function () {
      return TBR.settings.get();
    }).then(function (s) { prune(s.cacheTtlHours * 3600e3); });
  });

  load();
})();

/* Settings schema, defaults and storage. Shared by every context. */
var TBR = globalThis.TBR || (globalThis.TBR = {});

(function () {
  'use strict';

  var api = typeof browser !== 'undefined' ? browser : chrome;

  var DEFAULTS = {
    enabled: true,

    // Target ids from regions.js: "RU", "sub:europe/eastern", "cont:asia",
    // "grp:eu", "label:<slug>".
    blocked: [],

    // Handles (lowercase, no @) that are never hidden.
    allow: [],

    // handle -> target id. Beats whatever X says.
    overrides: {},

    // Which rows of X's "About this account" data to trust.
    sources: {
      basedIn: true,       // "Account based in"
      connectedVia: true   // "Connected via <country> App Store", used when there's no based-in
    },

    where: {
      feeds: true,         // home, lists, search, notifications, bookmarks
      replies: true,       // replies under a tweet
      quotes: true,        // hide a quoted tweet from a filtered author
      reposts: true,       // reposts of, and reposts by, filtered authors
      people: true,        // who-to-follow, follower lists, people search
      ownProfile: false,   // that author's own profile page
      openedTweet: false   // the tweet you opened by link
    },

    // allow | block | flag
    unclear: 'allow',      // X gave a region only partly on your list, or a place we don't know
    unknown: 'allow',      // X shows no location, or it hasn't been looked up yet

    placeholder: false,    // leave a "Hidden · Show" line instead of removing entirely
    holdBlank: true        // keep an entry blank for a moment while its author is looked up
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // Keeps only keys that exist in `base`, so a stale or hand-edited blob can't
  // smuggle in junk. `overrides` is a free-form map and is copied as is.
  function merge(base, over) {
    var out = clone(base);
    if (!over || typeof over !== 'object') return out;
    Object.keys(base).forEach(function (k) {
      var b = base[k], o = over[k];
      if (o === undefined || o === null) return;
      if (k === 'overrides') { if (typeof o === 'object') out[k] = clone(o); }
      else if (Array.isArray(b)) { if (Array.isArray(o)) out[k] = o.slice(); }
      else if (b && typeof b === 'object') out[k] = merge(b, o);
      else if (typeof o === typeof b) out[k] = o;
    });
    return out;
  }

  function get() {
    return api.storage.local.get('settings').then(function (r) {
      return merge(DEFAULTS, r && r.settings);
    });
  }

  function save(full) {
    var next = merge(DEFAULTS, full);
    return api.storage.local.set({ settings: next }).then(function () { return next; });
  }

  function update(partial) {
    return get().then(function (cur) { return save(merge(cur, partial)); });
  }

  function onChange(cb) {
    api.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && changes.settings) cb(merge(DEFAULTS, changes.settings.newValue));
    });
  }

  function lookupsOn(s) { return s.sources.basedIn || s.sources.connectedVia; }

  // Optional sync database (server/README.md). Its address and token live
  // under storage.local "db", not in settings, so an exported settings file
  // never carries the token. https only, except a server on this machine.
  function syncBase(url) {
    var u;
    try { u = new URL(String(url || '').trim()); } catch (e) { return null; }
    var local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
    if (u.username || u.password || u.search || u.hash) return null;
    return u.origin + u.pathname.replace(/\/+$/, '');
  }

  // Match patterns can't name a port, so this covers every port on the host.
  function syncPattern(base) {
    var u = new URL(base);
    return u.protocol + '//' + u.hostname + '/*';
  }

  TBR.sync = {
    DATA: ['websiteContent'],   // must match data_collection_permissions.optional
    base: syncBase,
    pattern: syncPattern
  };

  TBR.api = api;
  TBR.settings = {
    DEFAULTS: DEFAULTS,
    merge: merge,
    get: get,
    save: save,
    update: update,
    onChange: onChange,
    lookupsOn: lookupsOn
  };
})();

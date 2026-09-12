/* Settings schema, defaults, and storage plumbing shared by every context. */
var TBR = globalThis.TBR || (globalThis.TBR = {});

(function () {
  'use strict';

  var api = (typeof browser !== 'undefined' ? browser : chrome);

  var DEFAULTS = {
    enabled: true,

    // Target ids from regions.js: "RU", "sub:europe/eastern", "cont:asia",
    // "grp:eu", "label:whatever-x-said".
    blocked: [],

    // Handles that are never hidden, whatever their region says.
    allow: [],

    // handle (lowercase, no @) -> target id. Wins over every lookup source.
    overrides: {},

    surfaces: {
      timeline: true,        // Home / For you / Following
      replies: true,         // replies under a conversation
      quoted: true,          // a blocked author quoted inside someone else's tweet
      quotedHidesHost: false,// ...hide the whole host tweet instead of just the quote
      retweets: true,        // retweet of a blocked author
      retweeter: true,       // tweet retweeted *by* a blocked account
      notifications: true,
      search: true,
      lists: true,           // List timelines, bookmarks, communities
      profileTweets: false,  // tweets while you are on that author's own profile
      focusedTweet: false,   // the tweet you opened directly by URL
      userCells: true        // Who to follow, followers lists, people search
    },

    policy: {
      // X reported only a region, and you blocked a country inside it:
      // we cannot tell whether this author is that country.
      ambiguous: 'allow',    // allow | block | flag
      // X reported a place we could not map at all.
      unmapped: 'allow',     // allow | block | flag
      // X told us nothing / "Location unavailable".
      unknown: 'allow'       // allow | block | flag
    },

    display: {
      mode: 'hide',          // hide | placeholder
      showReason: true,
      blankWhilePending: true,
      pendingTimeoutMs: 2500
    },

    sources: {
      passive: true,         // read locations out of X's own API traffic
      active: true,          // ask X's API for an author we have not seen
      dom: true,             // scrape the "About this account" panel when open
      appStore: true,        // ...and fall back to its "Connected via <X> App Store" row
      selfReported: false    // fall back to the free-text profile location field
    },

    cacheTtlHours: 336,
    debug: false
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function merge(base, over) {
    var out = clone(base);
    if (!over || typeof over !== 'object') return out;
    Object.keys(base).forEach(function (k) {
      var b = base[k], o = over[k];
      if (o === undefined) return;
      if (b && typeof b === 'object' && !Array.isArray(b)) out[k] = merge(b, o);
      else if (Array.isArray(b)) out[k] = Array.isArray(o) ? o.slice() : out[k];
      else if (typeof o === typeof b) out[k] = o;
    });
    // overrides is a free-form map, merge() above only keeps known keys
    if (over.overrides && typeof over.overrides === 'object') out.overrides = clone(over.overrides);
    return out;
  }

  function get() {
    return api.storage.local.get('settings').then(function (res) {
      return merge(DEFAULTS, res && res.settings);
    });
  }

  function set(partial) {
    return get().then(function (cur) {
      var next = merge(cur, partial);
      if (partial && partial.overrides) next.overrides = clone(partial.overrides);
      if (partial && partial.blocked) next.blocked = partial.blocked.slice();
      if (partial && partial.allow) next.allow = partial.allow.slice();
      return api.storage.local.set({ settings: next }).then(function () { return next; });
    });
  }

  function replace(full) {
    var next = merge(DEFAULTS, full);
    return api.storage.local.set({ settings: next }).then(function () { return next; });
  }

  function onChange(cb) {
    api.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && changes.settings) cb(merge(DEFAULTS, changes.settings.newValue));
    });
  }

  TBR.api = api;
  TBR.settings = {
    DEFAULTS: DEFAULTS,
    get: get,
    set: set,
    replace: replace,
    merge: merge,
    onChange: onChange
  };
})();

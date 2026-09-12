/* Page-world half of the lookup layer.
 *
 * X never puts an author's country in the timeline DOM, so it has to come from
 * X's own API. This script runs in the page's world (not the content-script
 * sandbox) so that it can:
 *
 *   1. watch every fetch/XHR X makes and harvest any location it sees        [passive]
 *   2. memorise real request templates (URL + headers + variables) so the same
 *      call can be replayed for an author we have not seen yet               [active]
 *
 * It deliberately knows nothing about countries or regions — it reports raw
 * strings and lets the content script normalise them.
 */
(function () {
  'use strict';
  if (window.__tbrInjected) return;
  window.__tbrInjected = true;

  var TAG = 'tbr';
  var config = { passive: true, active: true, debug: false };
  var diag = {
    responsesScanned: 0, usersSeen: 0, locationsFound: 0,
    templates: {}, lastError: null, fieldsSeen: {}
  };

  function post(msg) {
    msg[TAG] = true;
    try { window.postMessage(msg, location.origin); } catch (e) { /* noop */ }
  }
  function log() {
    if (config.debug) console.debug.apply(console, ['[regionfilter]'].concat([].slice.call(arguments)));
  }

  /* ---------------------------------------------------------------- scanning */

  var COUNTRY_KEY = /^(country|countrycode|countryname|countryofresidence|basedincountry|accountcountry|profilecountry|locationcountry)$/;
  var REGION_KEY = /^(region|regionname|subregion|georegion|basedin|basedinregion|accountregion|locationregion|area)$/;
  var SELF_KEY = /^(location|locationname)$/;
  var NOISE = /(timezone|time_zone|phone|calling|currency|language|lang|url|href|id|token|color|colour)/;

  function norm(k) { return String(k).toLowerCase().replace(/[^a-z]/g, ''); }

  function usableString(v) {
    return typeof v === 'string' && v.length >= 2 && v.length <= 64 && !/^https?:/.test(v);
  }

  /* Walk a JSON value, calling visit(obj, keyPath) for every object. */
  function walk(node, visit, path, depth) {
    depth = depth || 0;
    if (depth > 24 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length && i < 400; i++) walk(node[i], visit, path, depth + 1);
      return;
    }
    visit(node, path);
    for (var k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      var v = node[k];
      if (v && typeof v === 'object') walk(v, visit, path ? path + '.' + k : k, depth + 1);
    }
  }

  function screenNameOf(o) {
    var sn = o.screen_name || (o.legacy && o.legacy.screen_name) ||
             (o.core && o.core.screen_name) || o.username;
    return usableString(sn) && /^[A-Za-z0-9_]{1,15}$/.test(sn) ? sn.toLowerCase() : null;
  }

  /* Find the best location claim inside one user subtree. */
  function locationIn(root, handleHint) {
    var best = null;

    walk(root, function (o, path) {
      var typename = String(o.__typename || o.type || '');
      var aboutish = /about|location|country|geo|region/i.test(path || '') ||
                     /About|Location|Country|Geo/.test(typename);

      for (var k in o) {
        if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
        var v = o[k];
        var nk = norm(k);
        if (NOISE.test(nk) && !COUNTRY_KEY.test(nk)) continue;

        // { country: { name: "Germany" } } and friends
        if (v && typeof v === 'object' && !Array.isArray(v) &&
            (COUNTRY_KEY.test(nk) || REGION_KEY.test(nk))) {
          v = v.name || v.value || v.text || v.label || v.location || v.country || v.region;
        }
        if (!usableString(v)) continue;

        var kind = null;
        if (COUNTRY_KEY.test(nk)) kind = 'country';
        else if (REGION_KEY.test(nk)) kind = 'region';
        else if (SELF_KEY.test(nk)) kind = aboutish ? 'region' : 'self';
        if (!kind) continue;

        if (config.debug) {
          var fk = (path ? path + '.' : '') + k;
          diag.fieldsSeen[fk] = (diag.fieldsSeen[fk] || 0) + 1;
        }

        var rank = kind === 'country' ? 3 : kind === 'region' ? 2 : 1;
        if (aboutish) rank += 1;
        if (!best || rank > best.rank) {
          best = { rank: rank, kind: kind, raw: v, field: (path ? path + '.' : '') + k };
        }
      }
    });

    if (best && handleHint) best.handle = handleHint;
    return best;
  }

  function scanPayload(json, ctxHandle, sourceTag) {
    var items = [];
    var seenUser = false;

    walk(json, function (o) {
      var handle = screenNameOf(o);
      if (!handle) return;
      seenUser = true;
      diag.usersSeen++;
      var loc = locationIn(o, handle);
      if (loc) {
        items.push({
          handle: handle, raw: loc.raw, kind: loc.kind,
          source: sourceTag, field: loc.field
        });
      }
    });

    // Payloads that are *about* one account may not repeat the screen name.
    if (!seenUser && ctxHandle) {
      var l = locationIn(json, ctxHandle);
      if (l) items.push({ handle: ctxHandle, raw: l.raw, kind: l.kind, source: sourceTag, field: l.field });
    }

    if (items.length) {
      diag.locationsFound += items.length;
      post({ type: 'locations', items: items });
      log('found', items);
    }
    return items.length;
  }

  /* ------------------------------------------------------- request templates */

  var templates = Object.create(null);   // opName -> {url, headers, variables}
  var pending = Object.create(null);     // handle -> true

  function opNameFromUrl(url) {
    var m = /\/graphql\/[^/]+\/([A-Za-z0-9_]+)/.exec(url);
    return m ? m[1] : null;
  }
  function handleFromUrl(url) {
    try {
      var u = new URL(url, location.origin);
      var vars = u.searchParams.get('variables');
      if (!vars) return null;
      var v = JSON.parse(vars);
      var sn = v.screen_name || v.screenName || v.username;
      return usableString(sn) ? sn.toLowerCase() : null;
    } catch (e) { return null; }
  }

  var KEEP_HEADERS = /^(authorization|x-csrf-token|x-twitter-|x-client-|content-type)/i;

  function rememberTemplate(url, headers) {
    var op = opNameFromUrl(url);
    if (!op) return;
    var have = templates[op];
    if (have && have.headers.authorization) return;   // already good enough
    var kept = {};
    Object.keys(headers || {}).forEach(function (h) {
      if (KEEP_HEADERS.test(h)) kept[h.toLowerCase()] = headers[h];
    });
    if (!kept.authorization) return;
    templates[op] = { url: url, headers: kept };
    diag.templates[op] = true;
    post({ type: 'diag', diag: snapshotDiag() });
    log('template learned', op);
  }

  function headersToObject(init) {
    var out = {};
    var h = init && init.headers;
    if (!h) return out;
    if (typeof Headers !== 'undefined' && h instanceof Headers) {
      h.forEach(function (v, k) { out[k] = v; });
    } else if (Array.isArray(h)) {
      h.forEach(function (p) { out[p[0]] = p[1]; });
    } else {
      Object.keys(h).forEach(function (k) { out[k] = h[k]; });
    }
    return out;
  }

  /* Replay a learned template with different variables. */
  function replay(op, mutateVars, ctxHandle) {
    var t = templates[op];
    if (!t) return Promise.reject(new Error('no template for ' + op));
    var u = new URL(t.url, location.origin);
    var vars = {};
    try { vars = JSON.parse(u.searchParams.get('variables') || '{}'); } catch (e) { /* */ }
    mutateVars(vars);
    u.searchParams.set('variables', JSON.stringify(vars));
    return nativeFetch(u.toString(), {
      method: 'GET',
      headers: t.headers,
      credentials: 'include',
      referrer: location.href
    }).then(function (r) {
      if (!r.ok) throw new Error(op + ' ' + r.status);
      return r.json();
    }).then(function (j) {
      return scanPayload(j, ctxHandle, 'api-' + op.toLowerCase());
    });
  }

  /* Ops whose response carries the disclosed country. X renames these, so the
   * list is discovered from the templates we actually learned rather than
   * guessed: anything about-shaped, known names first. */
  var ABOUT_OP_RE = /about|accountinfo|countryof|profilemodule/i;
  var ABOUT_OPS_KNOWN = [
    'AboutThisProfile', 'UserAboutProfile', 'ProfileAbout', 'AboutThisAccount',
    'UserAboutTimeline', 'UserAccountInfo', 'ProfileAboutModule'
  ];

  function aboutOps() {
    var seen = Object.create(null);
    var out = [];
    ABOUT_OPS_KNOWN.forEach(function (op) {
      if (templates[op]) { seen[op] = true; out.push(op); }
    });
    Object.keys(templates).forEach(function (op) {
      if (!seen[op] && ABOUT_OP_RE.test(op)) out.push(op);
    });
    return out;
  }

  function lookup(handle) {
    if (!config.active || pending[handle]) return;
    pending[handle] = true;
    var done = function (ok) {
      delete pending[handle];
      if (!ok) post({ type: 'lookupFailed', handle: handle });
    };

    var chain = Promise.resolve(0);

    aboutOps().forEach(function (op) {
      chain = chain.then(function (hits) {
        if (hits || !templates[op]) return hits;
        return replay(op, function (v) {
          v.screen_name = handle; v.screenName = handle; v.username = handle;
        }, handle).catch(function (e) { diag.lastError = String(e); return 0; });
      });
    });

    chain = chain.then(function (hits) {
      if (hits || !templates.UserByScreenName) return hits;
      return replay('UserByScreenName', function (v) {
        v.screen_name = handle; v.screenName = handle;
      }, handle).catch(function (e) { diag.lastError = String(e); return 0; });
    });

    chain.then(function (hits) { done(hits > 0); },
               function () { done(false); });
  }

  /* --------------------------------------------------------------- patching */

  var nativeFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var headers = headersToObject(init);
    if (!Object.keys(headers).length && input && input.headers) {
      headers = headersToObject({ headers: input.headers });
    }
    try { if (/\/graphql\//.test(url)) rememberTemplate(url, headers); } catch (e) { /* */ }

    var p = nativeFetch.apply(this, arguments);
    if (!config.passive) return p;

    return p.then(function (res) {
      try {
        var ct = res.headers.get('content-type') || '';
        if (/json/.test(ct) && /(\/graphql\/|\/i\/api\/)/.test(url)) {
          var ctx = handleFromUrl(url);
          res.clone().json().then(function (j) {
            diag.responsesScanned++;
            scanPayload(j, ctx, 'api-passive');
          }).catch(function () { /* */ });
        }
      } catch (e) { /* */ }
      return res;
    });
  };

  var openOrig = XMLHttpRequest.prototype.open;
  var sendOrig = XMLHttpRequest.prototype.send;
  var setHdrOrig = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__tbrUrl = url;
    this.__tbrHeaders = {};
    return openOrig.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this.__tbrHeaders) this.__tbrHeaders[String(k).toLowerCase()] = v;
    return setHdrOrig.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var self = this;
    try {
      if (/\/graphql\//.test(self.__tbrUrl || '')) rememberTemplate(self.__tbrUrl, self.__tbrHeaders);
    } catch (e) { /* */ }
    if (config.passive) {
      self.addEventListener('load', function () {
        try {
          var url = self.__tbrUrl || '';
          if (!/(\/graphql\/|\/i\/api\/)/.test(url)) return;
          var txt = self.responseType === '' || self.responseType === 'text' ? self.responseText : null;
          if (!txt || txt.charAt(0) !== '{') return;
          diag.responsesScanned++;
          scanPayload(JSON.parse(txt), handleFromUrl(url), 'api-passive');
        } catch (e) { /* */ }
      });
    }
    return sendOrig.apply(this, arguments);
  };

  /* ------------------------------------------------------------- messaging */

  function snapshotDiag() {
    return {
      responsesScanned: diag.responsesScanned,
      usersSeen: diag.usersSeen,
      locationsFound: diag.locationsFound,
      templates: Object.keys(diag.templates),
      lastError: diag.lastError,
      fieldsSeen: diag.fieldsSeen
    };
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d[TAG] !== true || !d.type || d.dir !== 'toPage') return;
    if (d.type === 'config') {
      config.passive = d.sources.passive !== false;
      config.active = d.sources.active !== false;
      config.debug = !!d.debug;
    } else if (d.type === 'lookup') {
      lookup(String(d.handle || '').toLowerCase());
    } else if (d.type === 'diag') {
      post({ type: 'diag', diag: snapshotDiag() });
    }
  });

  post({ type: 'ready' });
})();

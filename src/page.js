/* Page-world half: talks to X's API with the user's own session.
 *
 * The only place X discloses where an account is based is the "About this
 * account" GraphQL query:
 *
 *   GET /i/api/graphql/<queryId>/AboutAccountQuery?variables={"screenName":"x"}
 *   -> data.user_result_by_screen_name.result.about_profile
 *        .account_based_in   "United States"            (may be absent)
 *        .source             "United States App Store"  (how they connect)
 *        .location_accurate  false when X suspects a VPN/proxy
 *
 * Timeline payloads only carry the free-text profile location, so every
 * author has to be asked about individually, and X allows 50 of those per
 * 15 minutes. This script runs the requests on behalf of content.js and also
 * reads the answers to the ones X makes itself when you open an About page.
 *
 * It runs in the page's world (manifest "world": "MAIN") because the request
 * has to look exactly like X's own: same origin, same cookies, ct0 CSRF token.
 * It knows nothing about regions; content.js and background.js do the rest.
 */
(function () {
  'use strict';
  if (window.__tbrPage) return;
  window.__tbrPage = true;

  var OP = 'AboutAccountQuery';
  // X's public web-client token, the same one its own bundle sends.
  var BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
  var queryId = 'TzOG2twZEfhr9KmClvVVqA';
  var OP_URL = /\/i\/api\/graphql\/([A-Za-z0-9_-]+)\/AboutAccountQuery\b/;

  var nativeFetch = window.fetch;

  function post(msg) {
    msg.tbr = 'page';
    window.postMessage(msg, location.origin);
  }

  function csrf() {
    var m = /(?:^|;\s*)ct0=([^;]+)/.exec(document.cookie);
    return m ? m[1] : null;
  }

  function learnQueryId(id) {
    if (!id || id === queryId) return;
    queryId = id;
    post({ type: 'queryId', id: id });
  }

  /* --------------------------------------------------------------- parsing */

  function storeCountry(source) {
    var m = /^(.+?)\s+(?:app\s*store|play\s*store|google\s*play)$/i.exec(String(source || '').trim());
    return m ? m[1] : null;
  }

  // -> {found, basedIn, store, accurate}. found=false: no such account.
  function parse(json) {
    var res = json && json.data && json.data.user_result_by_screen_name;
    var user = res && res.result;
    if (!user || user.__typename !== 'User') return { found: false };
    var about = user.about_profile || {};
    return {
      found: true,
      basedIn: typeof about.account_based_in === 'string' ? about.account_based_in : null,
      store: storeCountry(about.source),
      accurate: about.location_accurate !== false
    };
  }

  function handleOf(url) {
    try {
      var v = JSON.parse(new URL(url, location.origin).searchParams.get('variables') || '{}');
      return typeof v.screenName === 'string' ? v.screenName.toLowerCase() : null;
    } catch (e) { return null; }
  }

  /* ------------------------------------------- X's own About-page requests */

  function observed(url, json) {
    var m = OP_URL.exec(url);
    if (!m) return;
    learnQueryId(m[1]);
    var handle = handleOf(url);
    if (handle && json) post({ type: 'result', handle: handle, info: parse(json), via: 'x' });
  }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var p = nativeFetch.apply(this, arguments);
    if (OP_URL.test(url)) {
      p.then(function (r) {
        if (r.ok) r.clone().json().then(function (j) { observed(url, j); }, function () {});
      }, function () {});
    }
    return p;
  };

  var xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var u = String(url || '');
    if (OP_URL.test(u)) {
      this.addEventListener('load', function () {
        try {
          if (this.status !== 200) return;
          var body = this.responseType === 'json' ? this.response
            : (this.responseType === '' || this.responseType === 'text') ? JSON.parse(this.responseText) : null;
          observed(u, body);
        } catch (e) { /* not ours to break */ }
      });
    }
    return xhrOpen.apply(this, arguments);
  };

  /* ------------------------------------------------------ query id recovery */

  // X rotates query ids on deploys. The current one lives in a lazy chunk
  // whose name and hash are listed in the inline webpack runtime:
  //   25823:"shared~bundle.UserAbout~loader.AboutAccount" ... 25823:"fa597f245541a6e3"
  //   -> https://abs.twimg.com/responsive-web/client-web/<name>.<hash>a.js
  //   which contains  params:{id:"<queryId>",...,name:"AboutAccountQuery"
  var discovering = null;
  function discover() {
    if (discovering) return discovering;
    discovering = new Promise(function (resolve) {
      var urls = [];
      var scripts = document.querySelectorAll('script:not([src])');
      for (var i = 0; i < scripts.length; i++) {
        var t = scripts[i].textContent || '';
        var re = /(\d+):"([^"]*AboutAccount[^"]*)"/g, m;
        while ((m = re.exec(t))) {
          var h = new RegExp('[{,]' + m[1] + ':"([0-9a-f]{8,})"').exec(t);
          if (h) urls.push('https://abs.twimg.com/responsive-web/client-web/' + m[2] + '.' + h[1] + 'a.js');
        }
      }
      var next = function () {
        var u = urls.shift();
        if (!u) return resolve(null);
        nativeFetch.call(window, u).then(function (r) { return r.text(); }).then(function (src) {
          var m = /id:"([A-Za-z0-9_-]+)",metadata:\{[^}]*\},name:"AboutAccountQuery"/.exec(src) ||
                  /queryId:"([A-Za-z0-9_-]+)",operationName:"AboutAccountQuery"/.exec(src);
          if (m) resolve(m[1]); else next();
        }, next);
      };
      next();
    }).then(function (id) {
      setTimeout(function () { discovering = null; }, 60000);
      if (id) learnQueryId(id);
      return id;
    });
    return discovering;
  }

  /* ----------------------------------------------------------- lookups */

  function limitOf(r) {
    var rem = r.headers.get('x-rate-limit-remaining');
    var lim = r.headers.get('x-rate-limit-limit');
    var reset = r.headers.get('x-rate-limit-reset');
    if (rem === null || reset === null) return null;
    return { remaining: +rem, limit: +lim || 50, reset: +reset * 1000 };
  }

  function request(handle) {
    var url = '/i/api/graphql/' + queryId + '/' + OP + '?variables=' +
      encodeURIComponent(JSON.stringify({ screenName: handle }));
    return nativeFetch.call(window, url, {
      credentials: 'include',
      headers: {
        authorization: 'Bearer ' + BEARER,
        'x-csrf-token': csrf() || '',
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes',
        'x-twitter-client-language': document.documentElement.lang || 'en',
        'content-type': 'application/json'
      }
    });
  }

  function lookup(handle, retried) {
    request(handle).then(function (r) {
      var limit = limitOf(r);
      if (r.status === 429) {
        post({ type: 'result', handle: handle, error: 'rate', limit: limit });
        return;
      }
      if ((r.status === 400 || r.status === 404) && !retried) {
        return discover().then(function (id) {
          if (id) lookup(handle, true);
          else post({ type: 'result', handle: handle, error: 'http ' + r.status + ' (query id stale?)', limit: limit });
        });
      }
      if (!r.ok) {
        post({ type: 'result', handle: handle, error: 'http ' + r.status, limit: limit });
        return;
      }
      return r.json().then(function (j) {
        post({ type: 'result', handle: handle, info: parse(j), limit: limit, via: 'lookup' });
      });
    }).catch(function (e) {
      post({ type: 'result', handle: handle, error: String(e && e.message || e) });
    });
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window || !ev.data || ev.data.tbr !== 'content') return;
    var d = ev.data;
    if (d.type === 'lookup' && /^[A-Za-z0-9_]{1,15}$/.test(d.handle || '')) lookup(d.handle.toLowerCase());
    else if (d.type === 'queryId' && /^[A-Za-z0-9_-]{8,40}$/.test(d.id || '')) queryId = d.id;
  });

  post({ type: 'ready' });
})();

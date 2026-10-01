/* Decide which entries to unlist, and unlist them.
 *
 * Nothing here blocks anything: entries are taken out of lists, while
 * profiles, permalinks and direct links keep working.
 *
 * Per author: ask background for a cached location; on a miss, queue the
 * handle and let pump() look it up through page.js when the shared budget
 * allows, nearest-to-the-viewport first. While a lookup is genuinely on its
 * way the entry is held blank for a moment (HOLD_MS) so something about to
 * be hidden doesn't flash past; after that, or whenever the budget is spent,
 * the "unknown" policy applies until an answer arrives.
 */
(function () {
  'use strict';

  var api = TBR.api;
  var R = TBR.regions;
  var M = TBR.matcher;

  var HOLD_MS = 2500;
  var MAX_INFLIGHT = 2;
  var ASK_TIMEOUT_MS = 20000;

  var settings = TBR.settings.DEFAULTS;
  var queryId = null;

  var recs = new Map();       // handle -> view record, or null (looked up, unresolvable)
  var firstSeen = new Map();  // handle -> when we first needed it
  var getQueue = new Set();   // handles waiting for a cache read
  var want = new Set();       // cache misses waiting for a lookup
  var asking = new Map();     // handle -> ts, sent to page.js
  var lastEl = new Map();     // handle -> an element showing it, for priority
  var revealed = new Set();   // "Show" clicks, cleared on navigation
  var limitedUntil = 0;       // no lookup budget until then
  var getTimer = null, pumpTimer = null, leasing = false;
  var counts = { hidden: 0, flagged: 0, pending: 0, unresolved: 0 };

  /* ------------------------------------------------------------ page.js */

  function toPage(msg) {
    msg.tbr = 'content';
    window.postMessage(msg, location.origin);
  }

  function send(msg) {
    return api.runtime.sendMessage(msg).catch(function () { return null; });
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window || !ev.data || ev.data.tbr !== 'page') return;
    var d = ev.data;
    if (d.type === 'ready') {
      if (queryId) toPage({ type: 'queryId', id: queryId });
    } else if (d.type === 'queryId') {
      queryId = d.id;
      send({ type: 'queryId', id: d.id });
    } else if (d.type === 'result') {
      onResult(d);
    }
  });

  function onResult(d) {
    var h = String(d.handle || '').toLowerCase();
    asking.delete(h);
    send({ type: 'result', handle: h, info: d.info, error: d.error, limit: d.limit }).then(function (r) {
      if (r && r.budget) limitedUntil = r.budget.until || 0;
      if (d.error === 'rate') want.add(h);
      else if (d.error && !recs.has(h)) { recs.set(h, null); schedule(); }
      pump();
    });
  }

  /* -------------------------------------------------------- background */

  api.runtime.onMessage.addListener(function (msg) {
    if (!msg) return;
    if (msg.type === 'updated') {
      Object.keys(msg.items).forEach(function (h) {
        recs.set(h, msg.items[h]);
        want.delete(h);
        asking.delete(h);
      });
      schedule();
    } else if (msg.type === 'cleared') {
      recs.clear();
      schedule();
    } else if (msg.type === 'pageStats') {
      return Promise.resolve({ counts: counts, limitedUntil: limitedUntil });
    } else if (msg.type === 'revealAll') {
      document.querySelectorAll('[data-tbr-handle]').forEach(function (el) {
        revealed.add(el.getAttribute('data-tbr-handle'));
      });
      schedule();
      return Promise.resolve({ ok: true });
    }
  });

  /* ---------------------------------------------------------- resolution */

  function lookupsOn() { return TBR.settings.lookupsOn(settings); }

  function need(h) {
    if (recs.has(h) || getQueue.has(h) || want.has(h) || asking.has(h)) return;
    if (!firstSeen.has(h)) firstSeen.set(h, Date.now());
    getQueue.add(h);
    if (!getTimer) getTimer = setTimeout(flushGet, 40);
  }

  function flushGet() {
    getTimer = null;
    var handles = Array.from(getQueue);
    if (!handles.length) return;
    send({ type: 'get', handles: handles }).then(function (r) {
      handles.forEach(function (h) {
        getQueue.delete(h);
        var rec = r && r.items ? r.items[h] : null;
        if (rec) recs.set(h, rec);
        else if (lookupsOn()) want.add(h);
        else recs.set(h, null);
      });
      if (r && r.budget) limitedUntil = r.budget.until || 0;
      if (r && r.queryId && r.queryId !== queryId) {
        queryId = r.queryId;
        toPage({ type: 'queryId', id: queryId });
      }
      schedule();
      pump();
    });
  }

  // Wanted handles, the ones on screen first, then below, then above. X only
  // keeps entries near the viewport in the DOM, so an author whose entry is
  // gone has been scrolled past: drop them rather than spend budget on them.
  // They're queued again if they come back.
  function prioritised() {
    var vh = window.innerHeight;
    var scored = [];
    want.forEach(function (h) {
      var el = lastEl.get(h);
      if (!el || !el.isConnected) {
        want.delete(h);
        lastEl.delete(h);
        firstSeen.delete(h);
        return;
      }
      var top = el.getBoundingClientRect().top;
      scored.push([top >= -200 && top < vh ? top : top >= vh ? vh + top : 2 * vh - top, h]);
    });
    scored.sort(function (a, b) { return a[0] - b[0]; });
    return scored.map(function (s) { return s[1]; });
  }

  function pump() {
    clearTimeout(pumpTimer);
    if (leasing || !want.size || !lookupsOn() || !active()) return;
    var now = Date.now();
    asking.forEach(function (ts, h) {
      if (now - ts > ASK_TIMEOUT_MS) { asking.delete(h); if (!recs.has(h)) recs.set(h, null); }
    });
    if (now < limitedUntil) {
      pumpTimer = setTimeout(pump, limitedUntil - now + 1000);
      return;
    }
    var room = MAX_INFLIGHT - asking.size;
    if (room <= 0) return;
    var order = prioritised().slice(0, room);
    leasing = true;
    send({ type: 'lease', handles: order }).then(function (r) {
      leasing = false;
      if (!r) return;
      r.grant.forEach(function (h) {
        want.delete(h);
        asking.set(h, Date.now());
        toPage({ type: 'lookup', handle: h });
      });
      // Not granted although budget remains: another tab has it in flight
      // or already cached it. Its answer arrives as an 'updated' broadcast;
      // re-read the cache in case it already did.
      if (!r.until) {
        order.forEach(function (h) {
          if (r.grant.indexOf(h) === -1) { want.delete(h); need(h); }
        });
      }
      limitedUntil = r.until || 0;
      schedule();
      pumpTimer = setTimeout(pump, limitedUntil ? limitedUntil - Date.now() + 1000 : 300);
    });
  }

  function verdictFor(h, el) {
    if (revealed.has(h) || settings.allow.indexOf(h) !== -1) return { action: 'allow' };
    var ov = settings.overrides[h];
    if (ov) return M.evaluate({ target: ov, raw: R.labelFor(ov), kind: 'override' }, settings);
    if (recs.has(h)) return M.evaluate(recs.get(h), settings);

    need(h);
    lastEl.set(h, el);
    var waitingForBudget = want.has(h) && Date.now() < limitedUntil;
    if (settings.holdBlank && !waitingForBudget && Date.now() - firstSeen.get(h) < HOLD_MS) {
      return { action: 'pending' };
    }
    return M.evaluate(null, settings);
  }

  /* ------------------------------------------------------------- context */

  var RESERVED = /^(i|home|explore|notifications|messages|settings|compose|search|hashtag|intent|login|logout|signup|tos|privacy|jobs|lists|bookmarks|communities)$/;

  function pageContext() {
    var p = location.pathname;
    if (/^\/(messages|settings|compose|i\/grok|i\/flow|login|logout)/.test(p)) return null;
    var st = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/.exec(p);
    if (st) return { surface: 'replies', statusId: st[2] };
    var prof = /^\/([A-Za-z0-9_]{1,15})(?:\/(?:with_replies|media|likes|highlights|articles|superfollows))?\/?$/.exec(p);
    if (prof && !RESERVED.test(prof[1].toLowerCase())) return { surface: 'profile', profile: prof[1].toLowerCase() };
    return { surface: 'feeds' };
  }

  function active() {
    return settings.enabled &&
      (settings.blocked.length > 0 || settings.unknown !== 'allow' || settings.unclear !== 'allow');
  }

  /* ---------------------------------------------------------- extraction */

  function handleFromHref(href) {
    var m = /^\/([A-Za-z0-9_]{1,15})(?:[/?#]|$)/.exec(href || '');
    if (!m || RESERVED.test(m[1].toLowerCase())) return null;
    return m[1].toLowerCase();
  }

  function handleIn(userName) {
    if (!userName) return null;
    var links = userName.querySelectorAll('a[href^="/"]');
    for (var i = 0; i < links.length; i++) {
      var h = handleFromHref(links[i].getAttribute('href'));
      if (h) return h;
    }
    var m = /@([A-Za-z0-9_]{1,15})/.exec(userName.textContent || '');
    return m ? m[1].toLowerCase() : null;
  }

  function quoteOf(article) {
    var cands = article.querySelectorAll('div[role="link"]');
    for (var i = 0; i < cands.length; i++) {
      if (cands[i].querySelector('[data-testid="User-Name"]')) return cands[i];
    }
    return null;
  }

  function reposterOf(article) {
    var sc = article.querySelector('[data-testid="socialContext"]');
    if (!sc) return null;
    var a = sc.closest('a[href^="/"]') || sc.querySelector('a[href^="/"]');
    var href = a && a.getAttribute('href');
    if (!href || href.indexOf('/status/') !== -1) return null;   // "Show this thread"
    return handleFromHref(href);
  }

  function describe(article, ctx) {
    var quote = quoteOf(article);
    var names = article.querySelectorAll('[data-testid="User-Name"]');
    var author = null;
    for (var i = 0; i < names.length && !author; i++) {
      if (!quote || !quote.contains(names[i])) author = handleIn(names[i]);
    }
    return {
      author: author,
      quote: quote,
      quoted: quote ? handleIn(quote.querySelector('[data-testid="User-Name"]')) : null,
      reposter: reposterOf(article),
      focused: ctx.surface === 'replies' && isOpened(article, quote, ctx.statusId)
    };
  }

  // The post you opened is the one X makes unfocusable (tabindex -1), and its
  // own timestamp links to the id in the URL. Links inside a quote don't count:
  // a reply quoting the opened post would otherwise match.
  function isOpened(article, quote, id) {
    if (article.getAttribute('tabindex') === '-1') return true;
    var links = article.querySelectorAll('a[href*="/status/' + id + '"]');
    for (var i = 0; i < links.length; i++) {
      if (quote && quote.contains(links[i])) continue;
      if (links[i].querySelector('time') && new RegExp('/status/' + id + '$').test(links[i].getAttribute('href'))) return true;
    }
    return false;
  }

  /* ----------------------------------------------------------- rendering */

  function note(el, text, handle, why) {
    var n = el.querySelector(':scope > .tbr-note');
    if (!n) {
      n = document.createElement('div');
      n.className = 'tbr-note';
      var span = document.createElement('span');
      span.className = 'tbr-note-text';
      var btn = document.createElement('button');
      btn.className = 'tbr-note-btn';
      btn.type = 'button';
      btn.textContent = 'Show';
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        revealed.add(n.getAttribute('data-handle'));
        schedule();
      }, true);
      n.appendChild(span);
      n.appendChild(btn);
      el.appendChild(n);
    }
    n.setAttribute('data-handle', handle);
    n.firstChild.textContent = text;
    n.title = why || '';
  }

  function dropNote(el) {
    var n = el.querySelector(':scope > .tbr-note');
    if (n) n.remove();
  }

  function setAttr(el, name, value) {
    if (value == null) { if (el.hasAttribute(name)) el.removeAttribute(name); }
    else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }

  // state: ok | pending | hidden | collapsed | flagged
  function mark(el, state, handle, v) {
    setAttr(el, 'data-tbr', state);
    setAttr(el, 'data-tbr-handle', state === 'ok' || state === 'pending' ? null : handle);
    if (state === 'collapsed') {
      note(el, 'Hidden: @' + handle + (v.label ? ' · ' + v.label : ''), handle, v.why);
    } else if (state === 'flagged') {
      note(el, 'Unclear location: @' + handle + (v.label ? ' · ' + v.label : ''), handle, v.why);
      el.querySelector(':scope > .tbr-note').classList.add('tbr-note-flag');
    } else {
      dropNote(el);
    }
    if (state === 'hidden') counts.hidden++;
    else if (state === 'collapsed') counts.hidden++;
    else if (state === 'flagged') counts.flagged++;
    else if (state === 'pending') counts.pending++;
  }

  function hide(el, handle, v) {
    mark(el, settings.placeholder ? 'collapsed' : 'hidden', handle, v);
  }

  // state: null | hidden | collapsed | flagged
  function markQuote(q, state, handle, v) {
    setAttr(q, 'data-tbr-quote', state);
    setAttr(q, 'data-tbr-handle', state ? handle : null);
    if (state === 'collapsed') note(q, 'Quoted tweet hidden: @' + handle + (v.label ? ' · ' + v.label : ''), handle, v.why);
    else dropNote(q);
    if (state === 'hidden' || state === 'collapsed') counts.hidden++;
    else if (state === 'flagged') counts.flagged++;
  }

  /* ------------------------------------------------------------ the pass */

  function processArticle(article, ctx) {
    var cell = article.closest('[data-testid="cellInnerDiv"]') || article;
    var info = describe(article, ctx);
    if (!info.author) return;
    var w = settings.where;

    var surfaceOn = ctx.surface === 'replies' ? w.replies : w.feeds;
    if (!surfaceOn || (info.focused && !w.openedTweet)) { mark(cell, 'ok'); clearQuote(info); return; }

    var hosts = [];
    var ownProfile = ctx.surface === 'profile';
    if (info.reposter) {
      if (w.reposts) {
        if (!(ownProfile && ctx.profile === info.reposter && !w.ownProfile)) hosts.push(info.reposter);
        hosts.push(info.author);
      }
    } else if (!(ownProfile && ctx.profile === info.author && !w.ownProfile)) {
      hosts.push(info.author);
    }

    var pending = false, flagged = null;
    for (var i = 0; i < hosts.length; i++) {
      var v = verdictFor(hosts[i], cell);
      if (v.action === 'block') { hide(cell, hosts[i], v); clearQuote(info); return; }
      if (v.action === 'pending') pending = true;
      else if (v.action === 'flag' && !flagged) flagged = { h: hosts[i], v: v };
    }

    if (info.quote) {
      var qv = w.quotes && info.quoted ? verdictFor(info.quoted, cell) : null;
      if (qv && qv.action === 'block') markQuote(info.quote, settings.placeholder ? 'collapsed' : 'hidden', info.quoted, qv);
      else if (qv && qv.action === 'flag') markQuote(info.quote, 'flagged', info.quoted, qv);
      else markQuote(info.quote, null);
      if (qv && qv.action === 'pending') pending = true;
    }

    if (flagged) mark(cell, 'flagged', flagged.h, flagged.v);
    else mark(cell, pending ? 'pending' : 'ok');
  }

  function clearQuote(info) {
    if (info.quote) markQuote(info.quote, null);
  }

  function processUserCell(uc) {
    var a = uc.querySelector('a[href^="/"]');
    var h = a ? handleFromHref(a.getAttribute('href')) : null;
    if (!h) return;
    var cell = uc.closest('[data-testid="cellInnerDiv"]') || uc;
    var v = verdictFor(h, cell);
    if (v.action === 'block') hide(cell, h, v);
    else if (v.action === 'flag') mark(cell, 'flagged', h, v);
    else mark(cell, v.action === 'pending' ? 'pending' : 'ok');
  }

  function sweep() {
    counts = { hidden: 0, flagged: 0, pending: 0, unresolved: 0 };
    var ctx = pageContext();
    if (!ctx || !active()) {
      resetMarks();
    } else {
      var arts = document.querySelectorAll('article[data-testid="tweet"]');
      for (var i = 0; i < arts.length; i++) processArticle(arts[i], ctx);
      var cells = document.querySelectorAll('[data-testid="UserCell"]');
      for (var j = 0; j < cells.length; j++) {
        if (settings.where.people) processUserCell(cells[j]);
        else mark(cells[j].closest('[data-testid="cellInnerDiv"]') || cells[j], 'ok');
      }
    }
    counts.unresolved = want.size + asking.size;
    if (counts.hidden !== lastBadge) {
      lastBadge = counts.hidden;
      send({ type: 'badge', count: counts.hidden });
    }
    // Held entries need another look once their hold runs out.
    if (counts.pending) setTimeout(schedule, 300);
  }
  var lastBadge = -1;

  function resetMarks() {
    document.querySelectorAll('[data-tbr],[data-tbr-quote]').forEach(function (el) {
      el.removeAttribute('data-tbr');
      el.removeAttribute('data-tbr-quote');
      el.removeAttribute('data-tbr-handle');
    });
    document.querySelectorAll('.tbr-note').forEach(function (n) { n.remove(); });
  }

  /* ------------------------------------------------------------- driving */

  // Next animation frame, so changes land before paint. Firefox pauses
  // animation frames in hidden tabs while X keeps loading there, hence the timer.
  var queued = false, frame = 0, timer = 0;
  function schedule() {
    if (queued) return;
    queued = true;
    frame = requestAnimationFrame(run);
    timer = setTimeout(run, 120);
  }
  function run() {
    if (!queued) return;
    queued = false;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    sweep();
  }

  var lastPath = location.pathname;
  function watchUrl() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    revealed.clear();
    schedule();
  }

  function applySettings(s) {
    settings = s;
    document.documentElement.setAttribute('data-tbr-hold', s.holdBlank ? '1' : '0');
  }

  function start() {
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    setInterval(watchUrl, 300);
    window.addEventListener('scroll', function () { if (want.size) pump(); }, { passive: true });
    schedule();
  }

  TBR.settings.get().then(function (s) {
    applySettings(s);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  });

  TBR.settings.onChange(function (s) {
    applySettings(s);
    recs.clear(); want.clear(); getQueue.clear();
    schedule();
  });
})();

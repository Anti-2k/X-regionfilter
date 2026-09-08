/* DOM engine: decide which entries get unlisted, and unlist them.
 *
 * Nothing here blocks anything. Entries are removed from lists only; the
 * account pages, the tweet permalinks and every direct link keep working.
 */
(function () {
  'use strict';

  var api = TBR.api;
  var R = TBR.regions;
  var M = TBR.matcher;

  var settings = TBR.settings.DEFAULTS;
  var recs = new Map();          // handle -> rec | null  (null = looked up, nothing known)
  var asked = new Set();         // handles we already asked the page to fetch
  var wantBatch = new Set();
  var batchTimer = null;
  var counts = { hidden: 0, flagged: 0, pending: 0 };
  var revealed = new Set();      // per-page manual reveals

  /* ------------------------------------------------------------ page world */

  function injectPageScript() {
    try {
      var s = document.createElement('script');
      s.src = api.runtime.getURL('src/inject.js');
      s.async = false;
      (document.head || document.documentElement).appendChild(s);
      s.addEventListener('load', function () { s.remove(); });
    } catch (e) { /* */ }
  }
  injectPageScript();

  function toPage(msg) {
    msg.tbr = true;
    msg.dir = 'toPage';
    try { window.postMessage(msg, location.origin); } catch (e) { /* */ }
  }

  var lastDiag = null;
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.tbr !== true || d.dir === 'toPage') return;

    if (d.type === 'ready') {
      toPage({ type: 'config', sources: settings.sources, debug: settings.debug });
    } else if (d.type === 'locations') {
      api.runtime.sendMessage({ type: 'put', items: d.items }).catch(function () { /* */ });
    } else if (d.type === 'lookupFailed') {
      if (!recs.has(d.handle)) { recs.set(d.handle, null); schedule(); }
    } else if (d.type === 'diag') {
      lastDiag = d.diag;
      api.storage.local.set({ diag: d.diag });
    }
  });

  api.runtime.onMessage.addListener(function (msg) {
    if (!msg) return;
    if (msg.type === 'updated') {
      Object.keys(msg.items).forEach(function (h) { recs.set(h, msg.items[h]); });
      schedule(true);
    } else if (msg.type === 'pageStats') {
      return Promise.resolve({ counts: counts, diag: lastDiag });
    } else if (msg.type === 'revealAll') {
      document.querySelectorAll('[data-tbr="hidden"],[data-tbr="collapsed"]').forEach(function (el) {
        var h = el.getAttribute('data-tbr-handle');
        if (h) revealed.add(h);
      });
      resetMarks();
      schedule(true);
      return Promise.resolve({ ok: true });
    } else if (msg.type === 'rescan') {
      recs.clear(); asked.clear(); resetMarks(); schedule(true);
      return Promise.resolve({ ok: true });
    }
  });

  /* ------------------------------------------------------------- resolution */

  function need(handle) {
    if (!handle || recs.has(handle)) return;
    wantBatch.add(handle);
    if (batchTimer) return;
    batchTimer = setTimeout(flushBatch, 60);
  }

  function flushBatch() {
    batchTimer = null;
    var handles = Array.from(wantBatch);
    wantBatch.clear();
    if (!handles.length) return;
    api.runtime.sendMessage({ type: 'get', handles: handles }).then(function (res) {
      var miss = [];
      handles.forEach(function (h) {
        var rec = res && res.items ? res.items[h] : null;
        if (rec) recs.set(h, rec);
        else miss.push(h);
      });
      miss.forEach(function (h) {
        if (asked.has(h)) { if (!recs.has(h)) recs.set(h, null); return; }
        asked.add(h);
        if (settings.sources.active) toPage({ type: 'lookup', handle: h });
        else recs.set(h, null);
      });
      schedule(true);
    }).catch(function () { /* */ });
  }

  function recFor(handle) {
    if (!handle) return undefined;
    var ov = settings.overrides[handle];
    if (ov) return { target: ov, raw: R.labelFor(ov), kind: 'override', source: 'override' };
    return recs.get(handle);
  }

  /* ---------------------------------------------------------------- surface */

  function pageContext() {
    var p = location.pathname;
    if (/^\/messages/.test(p)) return { surface: null };
    if (/^\/home\/?$/.test(p)) return { surface: 'timeline' };
    if (/^\/notifications/.test(p)) return { surface: 'notifications' };
    if (/^\/(search|explore)/.test(p)) return { surface: 'search' };
    if (/^\/i\/(lists|bookmarks|communities|topics)/.test(p) || /\/lists\//.test(p)) return { surface: 'lists' };
    if (/^\/i\/grok/.test(p)) return { surface: null };
    var st = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/.exec(p);
    if (st) return { surface: 'replies', statusOwner: st[1].toLowerCase(), statusId: st[2] };
    var prof = /^\/([A-Za-z0-9_]{1,15})(\/(with_replies|media|likes|highlights|superfollows|affiliates))?\/?$/.exec(p);
    if (prof && !/^(i|home|explore|notifications|messages|settings|compose|search)$/.test(prof[1])) {
      return { surface: 'profile', profile: prof[1].toLowerCase() };
    }
    return { surface: 'timeline' };
  }

  function surfaceEnabled(ctx) {
    var s = settings.surfaces;
    switch (ctx.surface) {
      case 'timeline': return s.timeline;
      case 'notifications': return s.notifications;
      case 'search': return s.search;
      case 'lists': return s.lists;
      case 'replies': return s.replies;
      case 'profile': return true; // per-entry check below
      default: return false;
    }
  }

  /* ------------------------------------------------------------ extraction */

  function handleFromHref(href) {
    if (!href) return null;
    var m = /^\/([A-Za-z0-9_]{1,15})(?:[/?#]|$)/.exec(href);
    if (!m) return null;
    var h = m[1].toLowerCase();
    if (/^(i|home|explore|notifications|messages|settings|compose|search|hashtag|intent)$/.test(h)) return null;
    return h;
  }

  function handleFromUserName(el) {
    if (!el) return null;
    var links = el.querySelectorAll('a[href^="/"]');
    for (var i = 0; i < links.length; i++) {
      var h = handleFromHref(links[i].getAttribute('href'));
      if (h) return h;
    }
    var m = /@([A-Za-z0-9_]{1,15})/.exec(el.textContent || '');
    return m ? m[1].toLowerCase() : null;
  }

  function quoteContainer(article) {
    var cands = article.querySelectorAll('div[role="link"]');
    for (var i = 0; i < cands.length; i++) {
      if (cands[i].querySelector('[data-testid="User-Name"]')) return cands[i];
    }
    return null;
  }

  function retweeterOf(article) {
    var sc = article.querySelector('[data-testid="socialContext"]');
    if (!sc) return null;
    var a = sc.closest('a[href^="/"]') || sc.querySelector('a[href^="/"]');
    if (!a) return null;
    if (/\/status\//.test(a.getAttribute('href') || '')) return null;  // "Show this thread"
    return handleFromHref(a.getAttribute('href'));
  }

  function describeArticle(article, ctx) {
    var quote = quoteContainer(article);
    var names = article.querySelectorAll('[data-testid="User-Name"]');
    var main = null;
    for (var i = 0; i < names.length; i++) {
      if (quote && quote.contains(names[i])) continue;
      main = handleFromUserName(names[i]);
      if (main) break;
    }
    return {
      author: main,
      quoted: quote ? handleFromUserName(quote.querySelector('[data-testid="User-Name"]')) : null,
      quoteEl: quote,
      retweeter: retweeterOf(article),
      focused: ctx.surface === 'replies' && !article.querySelector('a[href*="/status/"] time')
    };
  }

  /* ------------------------------------------------------------- rendering */

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
        e.preventDefault(); e.stopPropagation();
        if (handle) revealed.add(handle);
        el.removeAttribute('data-tbr');
        el.removeAttribute('data-tbr-sig');
        n.remove();
        schedule(true);
      }, true);
      n.appendChild(span);
      n.appendChild(btn);
      el.appendChild(n);
    }
    n.querySelector('.tbr-note-text').textContent = text;
    n.title = why || '';
    return n;
  }

  function clearNote(el) {
    var n = el.querySelector(':scope > .tbr-note');
    if (n) n.remove();
  }

  function apply(el, state, handle, label, why) {
    el.setAttribute('data-tbr', state);
    if (handle) el.setAttribute('data-tbr-handle', handle);
    if (state === 'collapsed') {
      note(el, 'Hidden — @' + handle + (settings.display.showReason && label ? ' · ' + label : ''), handle, why);
    } else if (state === 'flagged') {
      note(el, 'Unclear location' + (label ? ' · ' + label : ''), handle, why);
    } else {
      clearNote(el);
    }
  }

  function hideEl(el, handle, verdict) {
    var mode = settings.display.mode === 'placeholder' ? 'collapsed' : 'hidden';
    apply(el, mode, handle, verdict.label, verdict.why);
  }

  /* -------------------------------------------------------------- the pass */

  function verdictFor(handle) {
    if (!handle) return null;
    if (revealed.has(handle)) return { action: 'allow', why: 'revealed for this page' };
    if (settings.allow.indexOf(handle) !== -1) return { action: 'allow', why: 'allowlisted' };
    var rec = recFor(handle);
    if (rec === undefined) { need(handle); return { action: 'pending' }; }
    return M.evaluate(rec, settings);
  }

  function processArticle(article, ctx) {
    var container = article.closest('[data-testid="cellInnerDiv"]') || article;
    var info = describeArticle(article, ctx);
    if (!info.author) return;

    var sig = [info.author, info.quoted, info.retweeter, info.focused].join('|');
    if (container.getAttribute('data-tbr-sig') === sig && container.getAttribute('data-tbr') !== 'pending') return;
    container.setAttribute('data-tbr-sig', sig);

    var s = settings.surfaces;

    if (info.focused && !s.focusedTweet) { apply(container, 'ok'); return; }
    if (ctx.surface === 'profile' && ctx.profile === info.author && !s.profileTweets) {
      apply(container, 'ok'); return;
    }

    var pending = false;
    var checks = [];

    var isRetweet = !!info.retweeter;
    if (!isRetweet || s.retweets) checks.push({ handle: info.author, host: true });
    if (isRetweet && s.retweeter) checks.push({ handle: info.retweeter, host: true });
    if (info.quoted && s.quoted) checks.push({ handle: info.quoted, host: s.quotedHidesHost, quote: true });

    var quoteVerdict = null;

    for (var i = 0; i < checks.length; i++) {
      var c = checks[i];
      var v = verdictFor(c.handle);
      if (!v) continue;
      if (v.action === 'pending') { pending = true; continue; }
      if (v.action === 'block') {
        if (c.host) { hideEl(container, c.handle, v); return; }
        quoteVerdict = { v: v, handle: c.handle };
      } else if (v.action === 'flag' && c.host) {
        apply(container, 'flagged', c.handle, v.label, v.why);
        return;
      } else if (v.action === 'flag' && c.quote) {
        quoteVerdict = quoteVerdict || { v: v, handle: c.handle };
      }
    }

    if (info.quoteEl) {
      if (quoteVerdict) {
        var mode = quoteVerdict.v.action === 'flag' ? 'flagged'
                 : settings.display.mode === 'placeholder' ? 'collapsed' : 'quote-hidden';
        info.quoteEl.setAttribute('data-tbr-quote', mode);
        info.quoteEl.setAttribute('data-tbr-handle', quoteVerdict.handle);
        if (mode !== 'quote-hidden') {
          note(info.quoteEl,
               (mode === 'flagged' ? 'Quoted account: unclear location' : 'Quoted tweet hidden') +
               ' — @' + quoteVerdict.handle +
               (settings.display.showReason && quoteVerdict.v.label ? ' · ' + quoteVerdict.v.label : ''),
               quoteVerdict.handle, quoteVerdict.v.why);
        }
      } else {
        info.quoteEl.removeAttribute('data-tbr-quote');
        clearNote(info.quoteEl);
      }
    }

    apply(container, pending ? 'pending' : 'ok');
    if (pending) armPendingTimeout(container);
  }

  function processUserCell(cell) {
    var a = cell.querySelector('a[href^="/"]');
    var handle = a ? handleFromHref(a.getAttribute('href')) : null;
    if (!handle) return;
    var container = cell.closest('[data-testid="cellInnerDiv"]') || cell;
    if (container.getAttribute('data-tbr-sig') === handle &&
        container.getAttribute('data-tbr') !== 'pending') return;
    container.setAttribute('data-tbr-sig', handle);

    var v = verdictFor(handle);
    if (!v || v.action === 'pending') { apply(container, 'pending'); armPendingTimeout(container); return; }
    if (v.action === 'block') hideEl(container, handle, v);
    else if (v.action === 'flag') apply(container, 'flagged', handle, v.label, v.why);
    else apply(container, 'ok');
  }

  var pendingTimers = new WeakMap();
  function armPendingTimeout(el) {
    if (pendingTimers.has(el)) return;
    var t = setTimeout(function () {
      pendingTimers.delete(el);
      if (el.getAttribute('data-tbr') === 'pending') {
        el.setAttribute('data-tbr', 'ok');
        el.removeAttribute('data-tbr-sig');
      }
    }, Math.max(400, settings.display.pendingTimeoutMs));
    pendingTimers.set(el, t);
  }

  function sweep() {
    if (!settings.enabled) { resetMarks(); updateBadge(); return; }
    var ctx = pageContext();
    if (!ctx.surface) { resetMarks(); updateBadge(); return; }

    if (surfaceEnabled(ctx)) {
      var arts = document.querySelectorAll('article[data-testid="tweet"], article[role="article"]');
      for (var i = 0; i < arts.length; i++) {
        try { processArticle(arts[i], ctx); } catch (e) { if (settings.debug) console.warn(e); }
      }
    }
    if (settings.surfaces.userCells) {
      var cells = document.querySelectorAll('[data-testid="UserCell"]');
      for (var j = 0; j < cells.length; j++) {
        try { processUserCell(cells[j]); } catch (e) { if (settings.debug) console.warn(e); }
      }
    }
    scrapeAboutPanel();
    updateBadge();
  }

  function resetMarks() {
    document.querySelectorAll('[data-tbr],[data-tbr-sig],[data-tbr-quote]').forEach(function (el) {
      el.removeAttribute('data-tbr');
      el.removeAttribute('data-tbr-sig');
      el.removeAttribute('data-tbr-quote');
    });
    document.querySelectorAll('.tbr-note').forEach(function (n) { n.remove(); });
  }

  function updateBadge() {
    counts.hidden = document.querySelectorAll('[data-tbr="hidden"],[data-tbr="collapsed"]').length;
    counts.flagged = document.querySelectorAll('[data-tbr="flagged"]').length;
    counts.pending = document.querySelectorAll('[data-tbr="pending"]').length;
    api.runtime.sendMessage({ type: 'badge', count: counts.hidden }).catch(function () { /* */ });
  }

  /* ------------------------------------------- "About this account" scraper */

  var aboutSeen = new WeakSet();
  var ABOUT_RE = /\b(?:based in|account based in)\s*[:\-]?\s*([^\n·|]{2,60})/i;

  function scrapeAboutPanel() {
    if (!settings.sources.dom) return;
    var panels = document.querySelectorAll('[role="dialog"], [data-testid="sheetDialog"], [aria-labelledby]');
    for (var i = 0; i < panels.length; i++) {
      var p = panels[i];
      if (aboutSeen.has(p)) continue;
      var txt = p.textContent || '';
      var m = ABOUT_RE.exec(txt);
      if (!m) continue;
      aboutSeen.add(p);

      var handle = null;
      var hm = /@([A-Za-z0-9_]{1,15})/.exec(txt);
      if (hm) handle = hm[1].toLowerCase();
      if (!handle) {
        var ctx = pageContext();
        if (ctx.surface === 'profile') handle = ctx.profile;
      }
      if (!handle) continue;

      api.runtime.sendMessage({
        type: 'put',
        items: [{ handle: handle, raw: m[1].trim(), kind: 'region', source: 'dom-about' }]
      }).catch(function () { /* */ });
    }
  }

  /* ---------------------------------------------------------------- driving */

  var frame = null;
  function schedule(force) {
    if (force) {
      document.querySelectorAll('[data-tbr="pending"]').forEach(function (el) {
        el.removeAttribute('data-tbr-sig');
      });
    }
    if (frame) return;
    frame = requestAnimationFrame(function () { frame = null; sweep(); });
  }

  var lastUrl = location.href;
  function watchUrl() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    revealed.clear();
    resetMarks();
    schedule(true);
  }

  function start() {
    new MutationObserver(function () { schedule(); })
      .observe(document.documentElement, { childList: true, subtree: true });
    setInterval(watchUrl, 350);
    setInterval(function () { schedule(); }, 1500);
    setInterval(function () { toPage({ type: 'diag' }); }, 5000);
    schedule(true);
  }

  TBR.settings.get().then(function (s) {
    settings = s;
    document.documentElement.setAttribute('data-tbr-mode', s.display.blankWhilePending ? 'blank' : 'show');
    toPage({ type: 'config', sources: s.sources, debug: s.debug });
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
    } else {
      start();
    }
  });

  TBR.settings.onChange(function (s) {
    settings = s;
    document.documentElement.setAttribute('data-tbr-mode', s.display.blankWhilePending ? 'blank' : 'show');
    toPage({ type: 'config', sources: s.sources, debug: s.debug });
    recs.clear(); asked.clear();
    resetMarks();
    schedule(true);
  });
})();

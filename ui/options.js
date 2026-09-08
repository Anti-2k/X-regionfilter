(function () {
  'use strict';

  var api = TBR.api;
  var R = TBR.regions;
  var S = null;
  var saveTimer = null;

  var $ = function (id) { return document.getElementById(id); };

  function save(patch) {
    S = TBR.settings.merge(S, patch);
    if (patch.blocked) S.blocked = patch.blocked.slice();
    if (patch.allow) S.allow = patch.allow.slice();
    if (patch.overrides) S.overrides = patch.overrides;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      TBR.settings.replace(S).then(function () {
        $('saved').textContent = 'saved';
        setTimeout(function () { $('saved').textContent = ''; }, 1200);
      });
    }, 150);
  }

  /* --------------------------------------------------------------- places */

  function impliedBy(code) {
    // which selected target already covers this country?
    for (var i = 0; i < S.blocked.length; i++) {
      var t = S.blocked[i];
      if (t === code) continue;
      if (R.codesFor(t).indexOf(code) !== -1) return t;
    }
    return null;
  }

  function toggle(target, on) {
    var b = S.blocked.slice();
    var i = b.indexOf(target);
    if (on && i === -1) b.push(target);
    if (!on && i !== -1) b.splice(i, 1);
    save({ blocked: b });
    renderChips();
    repaint();
  }

  /* Repaint in place. Rebuilding the tree on every tick would collapse whatever
   * the user had open and throw away their scroll position. */
  function paint(l) {
    var target = l.dataset.target;
    var cb = l.querySelector("input");
    var lock = l.querySelector(".lock");
    var explicit = S.blocked.indexOf(target) !== -1;
    var imp = explicit ? null : (target.length === 2 ? impliedBy(target) : null);
    cb.checked = explicit || !!imp;
    cb.disabled = !!imp;
    l.classList.toggle("implied", !!imp);
    l.title = imp ? "already covered by " + R.labelFor(imp) : "";
    lock.textContent = imp ? "\u21b3 " + R.labelFor(imp) : "";
  }

  function repaint() {
    document.querySelectorAll("label[data-target]").forEach(paint);
  }

  function checkbox(target, label, extra) {
    var l = document.createElement("label");
    l.dataset.target = target;
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.addEventListener("change", function () { toggle(target, cb.checked); });
    var span = document.createElement("span");
    span.textContent = label;
    var lock = document.createElement("span");
    lock.className = "lock";
    l.appendChild(cb);
    l.appendChild(span);
    l.appendChild(lock);
    if (extra) l.appendChild(extra);
    l.dataset.search = (label + " " + target).toLowerCase();
    paint(l);
    return l;
  }

  function renderChips() {
    var box = $('chips');
    box.textContent = '';
    S.blocked.forEach(function (t) {
      var c = document.createElement('span');
      c.className = 'chip';
      c.appendChild(document.createTextNode(R.labelFor(t)));
      var x = document.createElement('button');
      x.type = 'button';
      x.textContent = '✕';
      x.title = 'remove';
      x.addEventListener('click', function () { toggle(t, false); });
      c.appendChild(x);
      box.appendChild(c);
    });
    $('selCount').textContent = String(S.blocked.length);
  }

  function renderGroups() {
    var box = $('groups');
    box.textContent = '';
    Object.keys(R.GROUPS).forEach(function (k) {
      box.appendChild(checkbox('grp:' + k, R.GROUPS[k][0]));
    });
  }

  function renderTree() {
    var box = $('tree');
    box.textContent = '';
    var bySub = {};
    Object.keys(R.SUBREGIONS).forEach(function (k) {
      var cont = R.SUBREGIONS[k][1];
      (bySub[cont] || (bySub[cont] = [])).push(k);
    });

    Object.keys(R.CONTINENTS).forEach(function (cont) {
      var d = document.createElement('details');
      d.className = 'cont';
      var sum = document.createElement('summary');
      sum.textContent = R.CONTINENTS[cont];
      d.appendChild(sum);

      var head = document.createElement('div');
      head.className = 'grid';
      head.appendChild(checkbox('cont:' + cont, 'All of ' + R.CONTINENTS[cont]));
      d.appendChild(head);

      (bySub[cont] || []).forEach(function (key) {
        var sd = document.createElement('details');
        sd.className = 'sub';
        var ss = document.createElement('summary');
        ss.textContent = R.SUBREGIONS[key][0];
        sd.appendChild(ss);

        var g = document.createElement('div');
        g.className = 'grid';
        g.appendChild(checkbox('sub:' + key, 'All of ' + R.SUBREGIONS[key][0]));
        R.SUB_CODES[key].slice().sort(function (a, b) {
          return R.COUNTRY_NAME[a].localeCompare(R.COUNTRY_NAME[b]);
        }).forEach(function (code) {
          g.appendChild(checkbox(code, R.COUNTRY_NAME[code]));
        });
        sd.appendChild(g);
        d.appendChild(sd);
      });
      box.appendChild(d);
    });
  }

  function renderLabels(byTarget) {
    var box = $('labels');
    box.textContent = '';
    var keys = Object.keys(byTarget || {}).filter(function (t) { return t.indexOf('label:') === 0; });
    S.blocked.forEach(function (t) {
      if (t.indexOf('label:') === 0 && keys.indexOf(t) === -1) keys.push(t);
    });
    if (!keys.length) {
      box.innerHTML = '<p class="hint">Nothing yet.</p>';
      return;
    }
    keys.sort().forEach(function (t) {
      var n = byTarget[t];
      var extra = document.createElement('span');
      extra.className = 'seen';
      extra.textContent = n ? '(' + n + ' seen)' : '';
      box.appendChild(checkbox(t, '“' + t.slice(6) + '”', extra));
    });
  }

  function renderPlaces() {
    searchTookOver = false;
    renderChips();
    renderGroups();
    renderTree();
    api.runtime.sendMessage({ type: 'cacheStats' }).then(function (r) {
      renderLabels(r && r.byTarget);
    }).catch(function () { renderLabels({}); });
    applySearch();
  }

  var searchTookOver = false;

  function applySearch() {
    var q = $("search").value.trim().toLowerCase();
    var details = document.querySelectorAll("#tree details");

    if (q && !searchTookOver) {
      // remember what was expanded before the search started opening things
      details.forEach(function (d) { d.dataset.prevOpen = d.open ? "1" : "0"; });
      searchTookOver = true;
    }

    document.querySelectorAll("#tree label, #groups label").forEach(function (l) {
      l.style.display = (!q || (l.dataset.search || "").indexOf(q) !== -1) ? "" : "none";
    });

    details.forEach(function (d) {
      var any = Array.prototype.some.call(d.querySelectorAll("label"), function (l) {
        return l.style.display !== "none";
      });
      d.style.display = any ? "" : "none";
      if (q) d.open = any;
    });

    if (!q && searchTookOver) {
      details.forEach(function (d) { d.open = d.dataset.prevOpen === "1"; });
      searchTookOver = false;
    }
  }

  /* -------------------------------------------------------------- surfaces */

  var SURFACES = [
    ['timeline', 'Home timeline (For you / Following)'],
    ['replies', 'Replies in a conversation'],
    ['quoted', 'A blocked author quoted inside someone else’s tweet'],
    ['quotedHidesHost', '…and hide the whole quoting tweet, not just the quote'],
    ['retweets', 'Reposts of a blocked author'],
    ['retweeter', 'Anything reposted by a blocked account'],
    ['notifications', 'Notifications'],
    ['search', 'Search and Explore'],
    ['lists', 'Lists, bookmarks and communities'],
    ['profileTweets', 'Tweets while you are on that author’s own profile'],
    ['focusedTweet', 'The tweet you opened directly by link'],
    ['userCells', 'Account suggestions and follower lists']
  ];

  var SOURCES = [
    ['passive', 'Read locations out of X’s own API traffic as you browse (free, no extra requests)'],
    ['active', 'Ask X’s API about authors we have not seen yet (needs X to have made the same kind of request once, so the shape can be replayed)'],
    ['dom', 'Read the “About this account” panel whenever you open one'],
    ['selfReported', 'Fall back to the account’s self-written profile location (unverified, easily faked)']
  ];

  function renderToggleList(boxId, defs, getter, setter) {
    var box = $(boxId);
    box.textContent = '';
    defs.forEach(function (d) {
      var l = document.createElement('label');
      l.className = 'row';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!getter(d[0]);
      cb.addEventListener('change', function () { setter(d[0], cb.checked); });
      var sp = document.createElement('span');
      sp.textContent = d[1];
      l.appendChild(cb);
      l.appendChild(sp);
      box.appendChild(l);
    });
  }

  /* -------------------------------------------------------------- accounts */

  function parseOverrides(text) {
    var out = {}, errs = [];
    text.split('\n').forEach(function (line, i) {
      var t = line.trim();
      if (!t || t.charAt(0) === '#') return;
      var m = /^@?([A-Za-z0-9_]{1,15})\s*[=:]\s*(.+)$/.exec(t);
      if (!m) { errs.push('line ' + (i + 1) + ': expected “@handle = place”'); return; }
      var target = R.parseLocation(m[2]);
      if (!target || target === 'unavailable') {
        errs.push('line ' + (i + 1) + ': “' + m[2].trim() + '” is not a place I know');
        return;
      }
      out[m[1].toLowerCase()] = target;
    });
    return { map: out, errors: errs };
  }

  function overridesToText(map) {
    return Object.keys(map).sort().map(function (h) {
      return '@' + h + ' = ' + R.labelFor(map[h]);
    }).join('\n');
  }

  /* ------------------------------------------------------------------ wire */

  function renderAll() {
    $('enabled').checked = S.enabled;
    renderPlaces();

    renderToggleList('surfaces', SURFACES,
      function (k) { return S.surfaces[k]; },
      function (k, v) { var p = { surfaces: {} }; p.surfaces[k] = v; save(p); });

    renderToggleList('sources', SOURCES,
      function (k) { return S.sources[k]; },
      function (k, v) { var p = { sources: {} }; p.sources[k] = v; save(p); });

    $('displayMode').value = S.display.mode;
    $('showReason').checked = S.display.showReason;
    $('blankWhilePending').checked = S.display.blankWhilePending;
    $('pendingTimeoutMs').value = S.display.pendingTimeoutMs;

    $('polAmbiguous').value = S.policy.ambiguous;
    $('polUnmapped').value = S.policy.unmapped;
    $('polUnknown').value = S.policy.unknown;

    $('allow').value = S.allow.map(function (h) { return '@' + h; }).join('\n');
    $('overrides').value = overridesToText(S.overrides);

    $('cacheTtlHours').value = S.cacheTtlHours;
    $('debug').checked = S.debug;
    refreshCacheStats();
    refreshDiag();
  }

  function refreshCacheStats() {
    api.runtime.sendMessage({ type: 'cacheStats' }).then(function (r) {
      $('cacheStats').textContent = (r ? r.size : 0) + ' account locations cached';
    }).catch(function () { });
  }

  function refreshDiag() {
    api.storage.local.get('diag').then(function (res) {
      var d = res && res.diag;
      if (!d) return;
      $('diag').textContent =
        'API responses scanned: ' + d.responsesScanned + '\n' +
        'user objects seen:     ' + d.usersSeen + '\n' +
        'locations found:       ' + d.locationsFound + '\n' +
        'replayable requests:   ' + (d.templates || []).join(', ') + '\n' +
        (d.lastError ? 'last error:            ' + d.lastError + '\n' : '') +
        (d.fieldsSeen && Object.keys(d.fieldsSeen).length
          ? '\nfields carrying a location:\n' +
            Object.keys(d.fieldsSeen).map(function (k) {
              return '  ' + k + '  ×' + d.fieldsSeen[k];
            }).join('\n')
          : '');
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('#tabs button').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('#tabs button').forEach(function (x) { x.classList.remove('on'); });
        document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        $('tab-' + b.dataset.tab).classList.add('on');
      });
    });

    $('enabled').addEventListener('change', function () { save({ enabled: $('enabled').checked }); });
    $('search').addEventListener('input', applySearch);
    $('clearSel').addEventListener('click', function () {
      save({ blocked: [] });
      renderChips();
      repaint();
    });

    ['displayMode', 'showReason', 'blankWhilePending', 'pendingTimeoutMs'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        save({
          display: {
            mode: $('displayMode').value,
            showReason: $('showReason').checked,
            blankWhilePending: $('blankWhilePending').checked,
            pendingTimeoutMs: Math.max(400, parseInt($('pendingTimeoutMs').value, 10) || 2500)
          }
        });
      });
    });

    ['polAmbiguous', 'polUnmapped', 'polUnknown'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        save({
          policy: {
            ambiguous: $('polAmbiguous').value,
            unmapped: $('polUnmapped').value,
            unknown: $('polUnknown').value
          }
        });
      });
    });

    $('allow').addEventListener('change', function () {
      var list = $('allow').value.split('\n').map(function (l) {
        var m = /@?([A-Za-z0-9_]{1,15})/.exec(l.trim());
        return m ? m[1].toLowerCase() : null;
      }).filter(Boolean);
      save({ allow: list });
    });

    $('overrides').addEventListener('change', function () {
      var p = parseOverrides($('overrides').value);
      $('overrideErrors').textContent = p.errors.join(' · ');
      save({ overrides: p.map });
    });

    $('cacheTtlHours').addEventListener('change', function () {
      save({ cacheTtlHours: Math.max(1, parseInt($('cacheTtlHours').value, 10) || 336) });
    });
    $('debug').addEventListener('change', function () { save({ debug: $('debug').checked }); });

    $('clearCache').addEventListener('click', function () {
      api.runtime.sendMessage({ type: 'clearCache' }).then(refreshCacheStats);
    });

    $('export').addEventListener('click', function () {
      var blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'regionfilter-settings.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    });
    $('importBtn').addEventListener('click', function () { $('importFile').click(); });
    $('importFile').addEventListener('change', function () {
      var f = $('importFile').files[0];
      if (!f) return;
      f.text().then(function (t) {
        return TBR.settings.replace(JSON.parse(t));
      }).then(function (s) { S = s; renderAll(); })
        .catch(function (e) { $('overrideErrors').textContent = 'import failed: ' + e; });
    });

    TBR.settings.get().then(function (s) { S = s; renderAll(); });
    setInterval(refreshDiag, 3000);
  });
})();

(function () {
  'use strict';

  var api = TBR.api;
  var R = TBR.regions;
  var S = null;
  var saveTimer = null;

  var $ = function (id) { return document.getElementById(id); };

  var WHERE = [
    ['feeds', 'Feeds', 'Home, lists, search, notifications and bookmarks.'],
    ['replies', 'Replies', 'Replies under a post you opened.'],
    ['quotes', 'Quoted posts', 'Hides just the quoted post inside someone else’s post.'],
    ['reposts', 'Reposts', 'Reposts of a filtered author, and anything a filtered account reposts.'],
    ['people', 'People lists', 'Who to follow, followers and following lists, people search.'],
    ['ownProfile', 'Their own profile', 'Also filter an author’s posts on their own profile page. Off means you see what you went looking for.'],
    ['openedTweet', 'The post you opened', 'Also filter the post itself when you open it by link.']
  ];

  /* ------------------------------------------------------------------ save */

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      TBR.settings.save(S).then(function (s) {
        S = s;
        var el = $('saved');
        el.textContent = 'Saved';
        el.classList.add('on');
        setTimeout(function () { el.classList.remove('on'); }, 1000);
      });
    }, 120);
  }

  function getKey(path) {
    return path.split('.').reduce(function (o, k) { return o[k]; }, S);
  }

  function setKey(path, value) {
    var keys = path.split('.');
    var o = S;
    for (var i = 0; i < keys.length - 1; i++) o = o[keys[i]];
    o[keys[keys.length - 1]] = value;
    save();
  }

  /* ---------------------------------------------------------------- places */

  // Which selected region already covers this country, if any.
  function coveredBy(code) {
    for (var i = 0; i < S.blocked.length; i++) {
      var t = S.blocked[i];
      if (t !== code && R.codesFor(t).indexOf(code) !== -1) return t;
    }
    return null;
  }

  function toggle(target, on) {
    var i = S.blocked.indexOf(target);
    if (on && i === -1) S.blocked.push(target);
    if (!on && i !== -1) S.blocked.splice(i, 1);
    save();
    renderChips();
    repaint();
  }

  // Repaint checkboxes in place. Rebuilding would collapse every open section
  // and lose the scroll position.
  function paint(l) {
    var t = l.dataset.target;
    var cb = l.querySelector('input');
    var on = S.blocked.indexOf(t) !== -1;
    var by = !on && /^[A-Z]{2}$/.test(t) ? coveredBy(t) : null;
    cb.checked = on || !!by;
    cb.disabled = !!by;
    l.classList.toggle('implied', !!by);
    l.querySelector('.lock').textContent = by ? 'via ' + R.labelFor(by) : '';
  }

  function repaint() {
    document.querySelectorAll('label[data-target]').forEach(paint);
  }

  function checkbox(target, text, cls) {
    var l = document.createElement('label');
    l.dataset.target = target;
    l.dataset.search = (text + ' ' + target).toLowerCase();
    if (cls) l.className = cls;
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.addEventListener('change', function () { toggle(target, cb.checked); });
    var span = document.createElement('span');
    span.textContent = text;
    var lock = document.createElement('span');
    lock.className = 'lock';
    l.append(cb, span, lock);
    paint(l);
    return l;
  }

  function renderChips() {
    var box = $('chips');
    box.textContent = '';
    if (!S.blocked.length) {
      var h = document.createElement('span');
      h.className = 'hint';
      h.textContent = 'Nothing selected yet.';
      box.appendChild(h);
      return;
    }
    S.blocked.forEach(function (t) {
      var c = document.createElement('span');
      c.className = 'chip';
      c.textContent = t.indexOf('label:') === 0 ? '“' + t.slice(6) + '”' : R.labelFor(t);
      var x = document.createElement('button');
      x.type = 'button';
      x.textContent = '✕';
      x.title = 'Remove';
      x.addEventListener('click', function () { toggle(t, false); });
      c.appendChild(x);
      box.appendChild(c);
    });
  }

  function renderPlaces() {
    var groups = $('groups');
    groups.textContent = '';
    Object.keys(R.GROUPS).forEach(function (k) {
      groups.appendChild(checkbox('grp:' + k, R.GROUPS[k][0]));
    });

    var subsOf = {};
    Object.keys(R.SUBREGIONS).forEach(function (k) {
      (subsOf[R.SUBREGIONS[k][1]] = subsOf[R.SUBREGIONS[k][1]] || []).push(k);
    });

    var tree = $('tree');
    tree.textContent = '';
    Object.keys(R.CONTINENTS).forEach(function (cont) {
      var d = document.createElement('details');
      d.className = 'cont';
      var sum = document.createElement('summary');
      sum.textContent = R.CONTINENTS[cont];
      var head = document.createElement('div');
      head.className = 'grid';
      head.appendChild(checkbox('cont:' + cont, 'All of ' + R.CONTINENTS[cont], 'all'));
      d.append(sum, head);

      (subsOf[cont] || []).forEach(function (key) {
        var sd = document.createElement('details');
        sd.className = 'sub';
        var ss = document.createElement('summary');
        ss.textContent = R.SUBREGIONS[key][0];
        var g = document.createElement('div');
        g.className = 'grid';
        g.appendChild(checkbox('sub:' + key, 'All of ' + R.SUBREGIONS[key][0], 'all'));
        R.SUB_CODES[key].slice().sort(function (a, b) {
          return R.COUNTRY_NAME[a].localeCompare(R.COUNTRY_NAME[b]);
        }).forEach(function (code) { g.appendChild(checkbox(code, R.COUNTRY_NAME[code])); });
        sd.append(ss, g);
        d.appendChild(sd);
      });
      tree.appendChild(d);
    });
    renderChips();
  }

  var searching = false;
  function applySearch() {
    var q = $('search').value.trim().toLowerCase();
    var details = document.querySelectorAll('#tree details');
    if (q && !searching) {
      details.forEach(function (d) { d.dataset.wasOpen = d.open ? '1' : ''; });
      searching = true;
    }
    document.querySelectorAll('#tree label, #groups label').forEach(function (l) {
      l.hidden = !!q && l.dataset.search.indexOf(q) === -1;
    });
    details.forEach(function (d) {
      var any = Array.prototype.some.call(d.querySelectorAll('label'), function (l) { return !l.hidden; });
      d.hidden = !any;
      if (q) d.open = any;
    });
    if (!q && searching) {
      details.forEach(function (d) { d.open = d.dataset.wasOpen === '1'; });
      searching = false;
    }
  }

  /* --------------------------------------------------------------- toggles */

  function renderWhere() {
    var box = $('where');
    WHERE.forEach(function (w) {
      var l = document.createElement('label');
      l.className = 'row';
      var text = document.createElement('span');
      var b = document.createElement('b');
      b.textContent = w[1];
      var sm = document.createElement('small');
      sm.textContent = w[2];
      text.append(b, sm);
      var sw = document.createElement('span');
      sw.className = 'switch';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.key = 'where.' + w[0];
      sw.append(cb, document.createElement('span'));
      l.append(text, sw);
      box.appendChild(l);
    });
  }

  function bindKeyed() {
    document.querySelectorAll('[data-key]').forEach(function (el) {
      el.addEventListener('change', function () {
        setKey(el.dataset.key, el.type === 'checkbox' ? el.checked : el.value);
      });
    });
  }

  function fillKeyed() {
    document.querySelectorAll('[data-key]').forEach(function (el) {
      var v = getKey(el.dataset.key);
      if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
    });
  }

  /* -------------------------------------------------------------- accounts */

  function parseOverrides(text) {
    var map = {}, errors = [];
    text.split('\n').forEach(function (line, i) {
      var t = line.trim();
      if (!t || t.charAt(0) === '#') return;
      var m = /^@?([A-Za-z0-9_]{1,15})\s*[=:]\s*(.+)$/.exec(t);
      if (!m) { errors.push('Line ' + (i + 1) + ': use “@handle = place”.'); return; }
      var target = R.parseLocation(m[2]);
      if (!target || target === 'unavailable' || target.indexOf('label:') === 0) {
        errors.push('Line ' + (i + 1) + ': “' + m[2].trim() + '” isn’t a place this extension knows.');
        return;
      }
      map[m[1].toLowerCase()] = target;
    });
    return { map: map, errors: errors };
  }

  function overridesText(map) {
    return Object.keys(map).sort().map(function (h) { return '@' + h + ' = ' + R.labelFor(map[h]); }).join('\n');
  }

  /* ---------------------------------------------------------------- status */

  function refreshStatus() {
    api.runtime.sendMessage({ type: 'stats' }).then(function (r) {
      if (!r) return;
      var lim = r.limit;
      if (lim) {
        var mins = Math.max(0, Math.ceil((lim.reset - Date.now()) / 60000));
        $('budget').textContent = lim.remaining + ' / ' + lim.limit;
        $('budgetNote').textContent = 'Resets in ' + mins + ' min. A few are always left for your own visits to About pages.';
      } else {
        $('budget').textContent = '–';
        $('budgetNote').textContent = 'Full budget available. X reports the count after the first lookup.';
      }
      var k = r.byKind || {};
      $('cacheSize').textContent = String(r.size);
      $('cacheNote').textContent = r.size
        ? (k.basedIn || 0) + ' with a “based in”, ' + (k.storeOnly || 0) + ' with only an App Store, ' +
          ((k.none || 0) + (k.missing || 0)) + ' with nothing.'
        : 'Nothing cached yet.';
      renderSeen(r.seen || {});
    }).catch(function () {});
  }

  function renderSeen(seen) {
    var box = $('seen');
    var keys = Object.keys(seen).sort(function (a, b) { return seen[b] - seen[a]; });
    var sig = keys.map(function (k) { return k + seen[k]; }).join('|') + S.blocked.join();
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.textContent = '';
    if (!keys.length) {
      box.innerHTML = '<span class="hint">Nothing yet.</span>';
      return;
    }
    keys.forEach(function (raw) {
      var t = R.parseLocation(raw);
      var row = document.createElement('div');
      var left = document.createElement('span');
      left.textContent = raw + ' ×' + seen[raw];
      var right;
      if (t && t.indexOf('label:') === 0) {
        right = checkbox(t, 'Hide this wording');
      } else {
        right = document.createElement('span');
        right.className = 'as';
        right.textContent = t === 'unavailable' ? 'no location' : 'read as ' + R.labelFor(t);
      }
      row.append(left, right);
      box.appendChild(row);
    });
  }

  /* ------------------------------------------------------------------ wire */

  function renderAll() {
    $('enabled').checked = S.enabled;
    renderPlaces();
    applySearch();
    fillKeyed();
    $('allow').value = S.allow.map(function (h) { return '@' + h; }).join('\n');
    $('overrides').value = overridesText(S.overrides);
    $('overrideErrors').textContent = '';
    refreshStatus();
  }

  document.addEventListener('DOMContentLoaded', function () {
    renderWhere();
    bindKeyed();

    $('enabled').addEventListener('change', function () { setKey('enabled', $('enabled').checked); });
    $('search').addEventListener('input', applySearch);
    $('clearSel').addEventListener('click', function () {
      S.blocked = [];
      save();
      renderChips();
      repaint();
    });

    $('allow').addEventListener('change', function () {
      S.allow = $('allow').value.split('\n').map(function (l) {
        var m = /^@?([A-Za-z0-9_]{1,15})$/.exec(l.trim());
        return m ? m[1].toLowerCase() : null;
      }).filter(Boolean);
      save();
    });

    $('overrides').addEventListener('change', function () {
      var p = parseOverrides($('overrides').value);
      $('overrideErrors').textContent = p.errors.join(' ');
      S.overrides = p.map;
      save();
    });

    $('clearCache').addEventListener('click', function () {
      api.runtime.sendMessage({ type: 'clearCache' }).then(refreshStatus);
    });

    $('export').addEventListener('click', function () {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' }));
      a.download = 'regionfilter-settings.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    });
    $('importBtn').addEventListener('click', function () { $('importFile').click(); });
    $('importFile').addEventListener('change', function () {
      var f = $('importFile').files[0];
      if (!f) return;
      f.text().then(function (t) { return TBR.settings.save(JSON.parse(t)); })
        .then(function (s) { S = s; renderAll(); })
        .catch(function (e) { $('overrideErrors').textContent = 'Import failed: ' + e.message; });
    });

    TBR.settings.get().then(function (s) { S = s; renderAll(); });
    setInterval(refreshStatus, 3000);
  });
})();

(function () {
  'use strict';
  var api = TBR.api;
  var $ = function (id) { return document.getElementById(id); };

  function toTab(msg) {
    return api.tabs.query({ active: true, currentWindow: true }).then(function (t) {
      return t[0] ? api.tabs.sendMessage(t[0].id, msg).catch(function () { return null; }) : null;
    });
  }

  function refresh() {
    toTab({ type: 'pageStats' }).then(function (r) {
      var c = r && r.counts;
      $('hidden').textContent = c ? c.hidden : '–';
      $('flagged').textContent = c ? c.flagged : '–';
      $('unresolved').textContent = c ? c.unresolved : '–';
      if (!r) $('note').textContent = 'Open x.com to see what’s filtered.';
    });
    api.runtime.sendMessage({ type: 'stats' }).then(function (s) {
      if (!s) return;
      if (s.limit) {
        var mins = Math.max(0, Math.ceil((s.limit.reset - Date.now()) / 60000));
        $('budget').textContent = s.limit.remaining + ' / ' + s.limit.limit;
        if (s.budget.left <= 0) $('note').textContent = 'Out of lookups for now; new authors show normally until X resets in ' + mins + ' min.';
      } else {
        $('budget').textContent = 'full';
      }
    }).catch(function () {});
  }

  TBR.settings.get().then(function (s) {
    $('enabled').checked = s.enabled;
    $('blocked').textContent = s.blocked.length;
    if (!s.blocked.length) $('note').textContent = 'Nothing picked yet. Open Settings to choose places.';
  });

  $('enabled').addEventListener('change', function () { TBR.settings.update({ enabled: $('enabled').checked }); });
  $('reveal').addEventListener('click', function () { toTab({ type: 'revealAll' }).then(refresh); });
  $('options').addEventListener('click', function () { api.runtime.openOptionsPage(); window.close(); });

  refresh();
  setInterval(refresh, 1000);
})();

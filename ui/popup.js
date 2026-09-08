(function () {
  'use strict';
  var api = TBR.api;
  var $ = function (id) { return document.getElementById(id); };

  function activeTab() {
    return api.tabs.query({ active: true, currentWindow: true }).then(function (t) { return t[0]; });
  }

  function ask(msg) {
    return activeTab().then(function (tab) {
      if (!tab) return null;
      return api.tabs.sendMessage(tab.id, msg).catch(function () { return null; });
    });
  }

  function refresh() {
    ask({ type: 'pageStats' }).then(function (r) {
      var c = (r && r.counts) || { hidden: 0, flagged: 0, pending: 0 };
      $('hidden').textContent = c.hidden;
      $('flagged').textContent = c.flagged;
      $('pending').textContent = c.pending;
    });
  }

  TBR.settings.get().then(function (s) {
    $('enabled').checked = s.enabled;
    $('blocked').textContent = s.blocked.length;
  });

  $('enabled').addEventListener('change', function () {
    TBR.settings.set({ enabled: $('enabled').checked });
  });
  $('reveal').addEventListener('click', function () { ask({ type: 'revealAll' }).then(refresh); });
  $('rescan').addEventListener('click', function () { ask({ type: 'rescan' }).then(refresh); });
  $('options').addEventListener('click', function () { api.runtime.openOptionsPage(); window.close(); });

  refresh();
  setInterval(refresh, 1000);
})();

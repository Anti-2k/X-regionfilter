/* Decide what to do with one author, given what X says about them.
 *
 * Both sides collapse to a set of ISO country codes:
 *
 *   author ⊆ blocked      -> block
 *   author ∩ blocked = ∅  -> allow
 *   partial overlap       -> settings.unclear
 *
 * The third case is real: X often reports a region ("Eastern Europe") rather
 * than a country. If you blocked Russia, an Eastern Europe account might be
 * Russian and might be Polish. That is left to the user, never guessed.
 */
var TBR = globalThis.TBR || (globalThis.TBR = {});

(function () {
  'use strict';

  var R = TBR.regions;

  var memoKey = null, memo = null;
  function blockedSet(blocked) {
    var key = blocked.join(',');
    if (key === memoKey) return memo;
    var codes = new Set(), labels = new Set();
    blocked.forEach(function (t) {
      if (t.indexOf('label:') === 0) labels.add(t);
      else R.codesFor(t).forEach(function (c) { codes.add(c); });
    });
    memoKey = key;
    memo = { codes: codes, labels: labels };
    return memo;
  }

  function verdict(policy, why, label) {
    return { action: policy === 'block' ? 'block' : policy === 'flag' ? 'flag' : 'allow', why: why, label: label };
  }

  /* rec: {target, raw, kind} as served by background.js view(), or null.
   * kind: country | region | appstore | override | none | missing          */
  function evaluate(rec, settings) {
    var v = decide(rec, settings);
    if (rec && rec.accurate === false && v.why) v.why += ' (X notes this may be inaccurate, e.g. a VPN)';
    return v;
  }

  function decide(rec, settings) {
    if (!rec || !rec.target || rec.target === 'unavailable') {
      return verdict(settings.unknown, rec ? 'X shows no location for this account' : 'location not looked up yet', '');
    }

    var label = rec.target.indexOf('label:') === 0 ? rec.raw : R.labelFor(rec.target);
    if (rec.kind === 'appstore') label += ' (App Store)';
    var b = blockedSet(settings.blocked);

    if (rec.target.indexOf('label:') === 0) {
      if (b.labels.has(rec.target)) return { action: 'block', why: '“' + rec.raw + '” is on your list', label: label };
      return verdict(settings.unclear, '“' + rec.raw + '” is not a place this extension recognises', label);
    }

    var mine = R.codesFor(rec.target);
    var hits = 0;
    for (var i = 0; i < mine.length; i++) if (b.codes.has(mine[i])) hits++;

    if (mine.length && hits === mine.length) {
      return { action: 'block', label: label,
               why: (mine.length === 1 ? label : 'all of ' + label) + ' is on your list' };
    }
    if (hits === 0) return { action: 'allow', label: label, why: label + ' is not on your list' };

    return verdict(settings.unclear,
      'X only says “' + label + '”: ' + hits + ' of ' + mine.length + ' countries there are on your list', label);
  }

  TBR.matcher = { evaluate: evaluate };
})();

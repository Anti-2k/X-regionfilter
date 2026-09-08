/* Decide what to do with an author whose location X reported (or didn't).
 *
 * Both sides of the comparison collapse to a set of ISO country codes:
 *
 *   blocked ⊇ author   ->  block   (every place the author could be is blocked)
 *   blocked ∩ author = ∅ -> allow
 *   partial overlap    ->  ambiguous
 *
 * The third case is the one that matters here. X frequently reports only a
 * subregion ("Eastern Europe") with no country. If you blocked Russia, an
 * Eastern Europe author *might* be Russian and might be Polish — there is no
 * honest yes/no, so it is surfaced as its own policy knob rather than guessed.
 */
var TBR = globalThis.TBR || (globalThis.TBR = {});

(function () {
  'use strict';

  var R = TBR.regions;

  var bcsKey = null, bcsVal = null;
  function blockedCodeSet(blocked) {
    var key = (blocked || []).join(",");
    if (key === bcsKey) return bcsVal;
    var set = new Set();
    var labels = new Set();
    (blocked || []).forEach(function (t) {
      if (t.indexOf('label:') === 0) { labels.add(t); return; }
      R.codesFor(t).forEach(function (c) { set.add(c); });
    });
    bcsKey = key;
    bcsVal = { codes: set, labels: labels };
    return bcsVal;
  }

  /* A location record as produced by the lookup layer:
   *   { target: "DE" | "sub:europe/eastern" | "label:x" | "unavailable" | null,
   *     raw: "Germany", source: "api-about" }                                */

  function describe(rec) {
    if (!rec || !rec.target) return 'unknown';
    if (rec.target === 'unavailable') return 'not disclosed';
    var l = R.labelFor(rec.target);
    if (rec.target.indexOf('label:') === 0) return rec.raw || l;
    return l;
  }

  /**
   * @returns {{action:'allow'|'block'|'flag', why:string, kind:string, label:string}}
   */
  function evaluate(rec, settings) {
    var pol = settings.policy || {};
    var label = describe(rec);

    if (!rec || !rec.target) {
      return decide(pol.unknown, 'unknown', 'author location not known yet', label);
    }
    if (rec.target === 'unavailable') {
      return decide(pol.unknown, 'unknown', 'X does not disclose this account’s location', label);
    }

    var b = blockedCodeSet(settings.blocked);

    // An unmappable label can only be matched literally.
    if (rec.target.indexOf('label:') === 0) {
      if (b.labels.has(rec.target)) {
        return { action: 'block', why: 'location "' + label + '" is on your list', kind: 'label', label: label };
      }
      return decide(pol.unmapped, 'unmapped', 'location "' + label + '" is not a place we recognise', label);
    }

    var mine = R.codesFor(rec.target);
    if (!mine.length) {
      return decide(pol.unmapped, 'unmapped', 'no countries known for "' + label + '"', label);
    }

    var hits = 0;
    for (var i = 0; i < mine.length; i++) if (b.codes.has(mine[i])) hits++;

    var isCountry = mine.length === 1 && rec.target === mine[0];

    if (hits === mine.length) {
      return {
        action: 'block',
        kind: isCountry ? 'country' : 'region',
        label: label,
        why: isCountry ? label + ' is on your list'
                       : 'all of ' + label + ' is on your list'
      };
    }
    if (hits === 0) {
      return { action: 'allow', kind: 'clear', label: label, why: label + ' is not on your list' };
    }

    // Partial: X gave a region, some of it is blocked. Cannot resolve honestly.
    return decide(
      pol.ambiguous, 'ambiguous',
      'X only says "' + label + '" — ' + hits + ' of ' + mine.length +
      ' countries there are on your list, so this could go either way',
      label
    );
  }

  function decide(policy, kind, why, label) {
    var action = policy === 'block' ? 'block' : policy === 'flag' ? 'flag' : 'allow';
    return { action: action, kind: kind, why: why, label: label };
  }

  /** Handles that can never be resolved further are worth not re-fetching. */
  function isTerminal(rec) {
    return !!rec && (rec.target === 'unavailable' || rec.source === 'override');
  }

  TBR.matcher = {
    evaluate: evaluate,
    describe: describe,
    blockedCodeSet: blockedCodeSet,
    isTerminal: isTerminal
  };
})();

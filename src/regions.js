/* Region taxonomy (UN M49) + label normalisation.
 *
 * Everything a user can block, and everything X can report as an author's
 * location, is reduced to a *set of ISO-3166-1 alpha-2 codes*. That makes the
 * "X only told us a subregion, not a country" case a plain set operation
 * instead of a pile of special cases. See matcher.js.
 */
var TBR = globalThis.TBR || (globalThis.TBR = {});

(function () {
  'use strict';

  // subregion key -> "CC:Name,CC:Name,..."
  var SUBREGIONS = {
    'africa/northern': ['Northern Africa', 'africa',
      'DZ:Algeria,EG:Egypt,LY:Libya,MA:Morocco,SD:Sudan,TN:Tunisia,EH:Western Sahara'],
    'africa/eastern': ['Eastern Africa', 'africa',
      'BI:Burundi,KM:Comoros,DJ:Djibouti,ER:Eritrea,ET:Ethiopia,KE:Kenya,MG:Madagascar,MW:Malawi,MU:Mauritius,YT:Mayotte,MZ:Mozambique,RE:Réunion,RW:Rwanda,SC:Seychelles,SO:Somalia,SS:South Sudan,UG:Uganda,TZ:Tanzania,ZM:Zambia,ZW:Zimbabwe,IO:British Indian Ocean Territory'],
    'africa/middle': ['Middle Africa', 'africa',
      'AO:Angola,CM:Cameroon,CF:Central African Republic,TD:Chad,CG:Congo,CD:DR Congo,GQ:Equatorial Guinea,GA:Gabon,ST:São Tomé and Príncipe'],
    'africa/southern': ['Southern Africa', 'africa',
      'BW:Botswana,SZ:Eswatini,LS:Lesotho,NA:Namibia,ZA:South Africa'],
    'africa/western': ['Western Africa', 'africa',
      'BJ:Benin,BF:Burkina Faso,CV:Cabo Verde,CI:Côte d’Ivoire,GM:Gambia,GH:Ghana,GN:Guinea,GW:Guinea-Bissau,LR:Liberia,ML:Mali,MR:Mauritania,NE:Niger,NG:Nigeria,SH:Saint Helena,SN:Senegal,SL:Sierra Leone,TG:Togo'],

    'americas/caribbean': ['Caribbean', 'americas',
      'AI:Anguilla,AG:Antigua and Barbuda,AW:Aruba,BS:Bahamas,BB:Barbados,BQ:Caribbean Netherlands,VG:British Virgin Islands,KY:Cayman Islands,CU:Cuba,CW:Curaçao,DM:Dominica,DO:Dominican Republic,GD:Grenada,GP:Guadeloupe,HT:Haiti,JM:Jamaica,MQ:Martinique,MS:Montserrat,PR:Puerto Rico,BL:Saint Barthélemy,KN:Saint Kitts and Nevis,LC:Saint Lucia,MF:Saint Martin,VC:Saint Vincent and the Grenadines,SX:Sint Maarten,TT:Trinidad and Tobago,TC:Turks and Caicos Islands,VI:U.S. Virgin Islands'],
    'americas/central': ['Central America', 'americas',
      'BZ:Belize,CR:Costa Rica,SV:El Salvador,GT:Guatemala,HN:Honduras,MX:Mexico,NI:Nicaragua,PA:Panama'],
    'americas/south': ['South America', 'americas',
      'AR:Argentina,BO:Bolivia,BV:Bouvet Island,BR:Brazil,CL:Chile,CO:Colombia,EC:Ecuador,FK:Falkland Islands,GF:French Guiana,GY:Guyana,PY:Paraguay,PE:Peru,GS:South Georgia,SR:Suriname,UY:Uruguay,VE:Venezuela'],
    'americas/northern': ['Northern America', 'americas',
      'BM:Bermuda,CA:Canada,GL:Greenland,PM:Saint Pierre and Miquelon,US:United States'],

    'asia/central': ['Central Asia', 'asia',
      'KZ:Kazakhstan,KG:Kyrgyzstan,TJ:Tajikistan,TM:Turkmenistan,UZ:Uzbekistan'],
    'asia/eastern': ['Eastern Asia', 'asia',
      'CN:China,HK:Hong Kong,JP:Japan,KP:North Korea,KR:South Korea,MO:Macao,MN:Mongolia,TW:Taiwan'],
    'asia/south-eastern': ['South-eastern Asia', 'asia',
      'BN:Brunei,KH:Cambodia,ID:Indonesia,LA:Laos,MY:Malaysia,MM:Myanmar,PH:Philippines,SG:Singapore,TH:Thailand,TL:Timor-Leste,VN:Vietnam'],
    'asia/southern': ['Southern Asia', 'asia',
      'AF:Afghanistan,BD:Bangladesh,BT:Bhutan,IN:India,IR:Iran,MV:Maldives,NP:Nepal,PK:Pakistan,LK:Sri Lanka'],
    'asia/western': ['Western Asia', 'asia',
      'AM:Armenia,AZ:Azerbaijan,BH:Bahrain,CY:Cyprus,GE:Georgia,IQ:Iraq,IL:Israel,JO:Jordan,KW:Kuwait,LB:Lebanon,OM:Oman,PS:Palestine,QA:Qatar,SA:Saudi Arabia,SY:Syria,TR:Türkiye,AE:United Arab Emirates,YE:Yemen'],

    'europe/eastern': ['Eastern Europe', 'europe',
      'BY:Belarus,BG:Bulgaria,CZ:Czechia,HU:Hungary,PL:Poland,MD:Moldova,RO:Romania,RU:Russia,SK:Slovakia,UA:Ukraine'],
    'europe/northern': ['Northern Europe', 'europe',
      'AX:Åland Islands,DK:Denmark,EE:Estonia,FO:Faroe Islands,FI:Finland,GG:Guernsey,IS:Iceland,IE:Ireland,IM:Isle of Man,JE:Jersey,LV:Latvia,LT:Lithuania,NO:Norway,SJ:Svalbard and Jan Mayen,SE:Sweden,GB:United Kingdom'],
    'europe/southern': ['Southern Europe', 'europe',
      'AL:Albania,AD:Andorra,BA:Bosnia and Herzegovina,HR:Croatia,GI:Gibraltar,GR:Greece,VA:Vatican City,IT:Italy,MT:Malta,ME:Montenegro,MK:North Macedonia,PT:Portugal,SM:San Marino,RS:Serbia,SI:Slovenia,ES:Spain'],
    'europe/western': ['Western Europe', 'europe',
      'AT:Austria,BE:Belgium,FR:France,DE:Germany,LI:Liechtenstein,LU:Luxembourg,MC:Monaco,NL:Netherlands,CH:Switzerland'],

    'oceania/australasia': ['Australia and New Zealand', 'oceania',
      'AU:Australia,CX:Christmas Island,CC:Cocos (Keeling) Islands,HM:Heard and McDonald Islands,NZ:New Zealand,NF:Norfolk Island'],
    'oceania/melanesia': ['Melanesia', 'oceania',
      'FJ:Fiji,NC:New Caledonia,PG:Papua New Guinea,SB:Solomon Islands,VU:Vanuatu'],
    'oceania/micronesia': ['Micronesia', 'oceania',
      'GU:Guam,KI:Kiribati,MH:Marshall Islands,FM:Micronesia,NR:Nauru,MP:Northern Mariana Islands,PW:Palau,UM:U.S. Minor Outlying Islands'],
    'oceania/polynesia': ['Polynesia', 'oceania',
      'AS:American Samoa,CK:Cook Islands,PF:French Polynesia,NU:Niue,PN:Pitcairn,WS:Samoa,TK:Tokelau,TO:Tonga,TV:Tuvalu,WF:Wallis and Futuna'],

    'antarctica': ['Antarctica', 'antarctica',
      'AQ:Antarctica,TF:French Southern Territories']
  };

  var CONTINENTS = {
    africa: 'Africa',
    americas: 'Americas',
    asia: 'Asia',
    europe: 'Europe',
    oceania: 'Oceania',
    antarctica: 'Antarctica'
  };

  /* Cross-cutting groups. X's "About this account" panel does not stick to
   * M49 — it also shows things like "European Union" or "Middle East". */
  var GROUPS = {
    'eu': ['European Union',
      'AT,BE,BG,HR,CY,CZ,DK,EE,FI,FR,DE,GR,HU,IE,IT,LV,LT,LU,MT,NL,PL,PT,RO,SK,SI,ES,SE'],
    'eea': ['European Economic Area',
      'AT,BE,BG,HR,CY,CZ,DK,EE,FI,FR,DE,GR,HU,IE,IT,LV,LT,LU,MT,NL,PL,PT,RO,SK,SI,ES,SE,IS,LI,NO'],
    'middle-east': ['Middle East',
      'BH,CY,EG,IR,IQ,IL,JO,KW,LB,OM,PS,QA,SA,SY,TR,AE,YE'],
    'nordics': ['Nordic countries', 'DK,FI,IS,NO,SE,AX,FO,GL,SJ'],
    'baltics': ['Baltic states', 'EE,LV,LT'],
    'balkans': ['Balkans', 'AL,BA,BG,HR,GR,XK,ME,MK,RO,RS,SI'],
    'caucasus': ['Caucasus', 'AM,AZ,GE'],
    'central-europe': ['Central Europe', 'AT,CZ,DE,HU,LI,PL,SK,SI,CH'],
    'latin-america': ['Latin America', null], // filled below
    'sub-saharan-africa': ['Sub-Saharan Africa', null],
    'commonwealth-ind-states': ['CIS / post-Soviet', 'AM,AZ,BY,KZ,KG,MD,RU,TJ,TM,UA,UZ,GE'],
    'anglosphere': ['Anglosphere', 'US,GB,CA,AU,NZ,IE'],
    'gulf': ['Gulf states', 'BH,KW,OM,QA,SA,AE']
  };

  var COUNTRY_NAME = Object.create(null);   // "US" -> "United States"
  var COUNTRY_SUB = Object.create(null);    // "US" -> "americas/northern"
  var SUB_CODES = Object.create(null);      // "americas/northern" -> ["US",...]
  var CONT_CODES = Object.create(null);     // "americas" -> ["US",...]

  Object.keys(SUBREGIONS).forEach(function (key) {
    var entry = SUBREGIONS[key];
    var codes = [];
    entry[2].split(',').forEach(function (pair) {
      var i = pair.indexOf(':');
      var code = pair.slice(0, i);
      var name = pair.slice(i + 1);
      COUNTRY_NAME[code] = name;
      COUNTRY_SUB[code] = key;
      codes.push(code);
    });
    SUB_CODES[key] = codes;
    var cont = entry[1];
    (CONT_CODES[cont] || (CONT_CODES[cont] = [])).push.apply(CONT_CODES[cont], codes);
  });

  // Kosovo has no official ISO code but X may report it.
  COUNTRY_NAME.XK = 'Kosovo';
  COUNTRY_SUB.XK = 'europe/southern';
  SUB_CODES['europe/southern'].push('XK');
  CONT_CODES.europe.push('XK');

  /* Transcontinental fix-ups: M49 files Cyprus under Western Asia, but every
   * political grouping X is likely to use (and the EU itself) treats it as
   * European. Without this, blocking 'Europe' leaves 'European Union' as a
   * partial match forever. */
  CONT_CODES.europe.push('CY');

  GROUPS['latin-america'][1] = []
    .concat(SUB_CODES['americas/caribbean'], SUB_CODES['americas/central'], SUB_CODES['americas/south'])
    .join(',');
  GROUPS['sub-saharan-africa'][1] = []
    .concat(SUB_CODES['africa/eastern'], SUB_CODES['africa/middle'],
            SUB_CODES['africa/southern'], SUB_CODES['africa/western'])
    .join(',');

  /* ---- target ids -------------------------------------------------------
   * A "target" is anything selectable in the options UI or reportable by X:
   *   "US"                    a country
   *   "sub:europe/eastern"    an M49 subregion
   *   "cont:europe"           a continent
   *   "grp:eu"                a named group
   *   "label:<slug>"          an opaque string X gave us that we can't map
   */

  function codesFor(target) {
    if (!target) return [];
    if (target.indexOf('sub:') === 0) return SUB_CODES[target.slice(4)] || [];
    if (target.indexOf('cont:') === 0) return CONT_CODES[target.slice(5)] || [];
    if (target.indexOf('grp:') === 0) {
      var g = GROUPS[target.slice(4)];
      return g ? g[1].split(',') : [];
    }
    if (target.indexOf('label:') === 0) return [];
    return COUNTRY_NAME[target] ? [target] : [];
  }

  function labelFor(target) {
    if (!target) return '';
    if (target.indexOf('sub:') === 0) {
      var s = SUBREGIONS[target.slice(4)];
      return s ? s[0] : target.slice(4);
    }
    if (target.indexOf('cont:') === 0) return CONTINENTS[target.slice(5)] || target.slice(5);
    if (target.indexOf('grp:') === 0) {
      var g = GROUPS[target.slice(4)];
      return g ? g[0] : target.slice(4);
    }
    if (target.indexOf('label:') === 0) return target.slice(6);
    return COUNTRY_NAME[target] || target;
  }

  /* ---- normalising whatever string X hands us --------------------------- */

  function slug(s) {
    return String(s || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[’'`]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  // Prefixes/suffixes X wraps the value in, in the panel and in some API fields.
  var STRIP = [
    /^based\s+in\s+/i, /^account\s+based\s+in\s+/i, /^located\s+in\s+/i,
    /^location\s*[:\-]\s*/i, /^country\s*[:\-]\s*/i, /^region\s*[:\-]\s*/i,
    /^from\s+/i, /^in\s+/i, /\s*\(.*\)\s*$/
  ];

  var ALIAS = Object.create(null);
  function alias(names, target) {
    names.split('|').forEach(function (n) { ALIAS[slug(n)] = target; });
  }

  // country aliases (the canonical names above are registered automatically)
  alias('usa|us|u s|u s a|united states of america|america|the united states', 'US');
  alias('uk|u k|great britain|britain|england|scotland|wales|northern ireland|the united kingdom', 'GB');
  alias('south korea|republic of korea|korea|korea south', 'KR');
  alias('north korea|dprk|korea north', 'KP');
  alias('russian federation|russia', 'RU');
  alias('turkey|turkiye|republic of turkiye', 'TR');
  alias('czech republic|czechia', 'CZ');
  alias('ivory coast|cote divoire', 'CI');
  alias('cape verde', 'CV');
  alias('swaziland', 'SZ');
  alias('burma', 'MM');
  alias('macedonia|former yugoslav republic of macedonia', 'MK');
  alias('holland|the netherlands', 'NL');
  alias('uae|emirates', 'AE');
  alias('drc|dr congo|democratic republic of the congo|congo kinshasa|congo drc', 'CD');
  alias('republic of the congo|congo brazzaville', 'CG');
  alias('taiwan|republic of china|chinese taipei', 'TW');
  alias('hong kong sar|hong kong sar china', 'HK');
  alias('macau|macao sar', 'MO');
  alias('palestinian territories|state of palestine|west bank|gaza|gaza strip', 'PS');
  alias('bolivia plurinational state of', 'BO');
  alias('venezuela bolivarian republic of', 'VE');
  alias('tanzania united republic of', 'TZ');
  alias('moldova republic of|republic of moldova', 'MD');
  alias('brunei darussalam', 'BN');
  alias('micronesia federated states of', 'FM');
  alias('vatican|holy see', 'VA');
  alias('laos peoples democratic republic|lao pdr', 'LA');
  alias('syrian arab republic', 'SY');
  alias('iran islamic republic of', 'IR');
  alias('viet nam', 'VN');
  alias('mainland china|peoples republic of china|prc', 'CN');
  alias('kosovo|republic of kosovo', 'XK');

  // region / group aliases
  alias('european union|the european union|eu', 'grp:eu');
  alias('european economic area|eea', 'grp:eea');
  alias('middle east|the middle east|middle east and north africa|mena', 'grp:middle-east');
  alias('nordics|nordic countries|scandinavia', 'grp:nordics');
  alias('baltics|baltic states', 'grp:baltics');
  alias('the balkans|balkans|southeast europe|south east europe', 'grp:balkans');
  alias('caucasus|the caucasus|south caucasus', 'grp:caucasus');
  alias('central europe', 'grp:central-europe');
  alias('latin america|latin america and the caribbean|latam', 'grp:latin-america');
  alias('sub saharan africa|subsaharan africa', 'grp:sub-saharan-africa');
  alias('cis|post soviet states|former soviet union', 'grp:commonwealth-ind-states');
  alias('gulf|gulf states|gcc|persian gulf|arabian gulf', 'grp:gulf');
  alias('anglosphere', 'grp:anglosphere');

  alias('southeast asia|south east asia|south eastern asia', 'sub:asia/south-eastern');
  alias('south asia|southern asia|indian subcontinent', 'sub:asia/southern');
  alias('east asia|eastern asia', 'sub:asia/eastern');
  alias('west asia|western asia', 'sub:asia/western');
  alias('central asia', 'sub:asia/central');
  alias('north america|northern america', 'sub:americas/northern');
  alias('central america', 'sub:americas/central');
  alias('south america|southern america', 'sub:americas/south');
  alias('caribbean|the caribbean|west indies', 'sub:americas/caribbean');
  alias('east europe|eastern europe', 'sub:europe/eastern');
  alias('west europe|western europe', 'sub:europe/western');
  alias('north europe|northern europe', 'sub:europe/northern');
  alias('south europe|southern europe', 'sub:europe/southern');
  alias('north africa|northern africa', 'sub:africa/northern');
  alias('east africa|eastern africa', 'sub:africa/eastern');
  alias('west africa|western africa', 'sub:africa/western');
  alias('central africa|middle africa', 'sub:africa/middle');
  alias('southern africa', 'sub:africa/southern');
  alias('australia and new zealand|australasia|oceania australia and new zealand', 'sub:oceania/australasia');
  alias('melanesia', 'sub:oceania/melanesia');
  alias('micronesia region|micronesia subregion', 'sub:oceania/micronesia');
  alias('polynesia', 'sub:oceania/polynesia');

  alias('africa', 'cont:africa');
  alias('americas|the americas', 'cont:americas');
  alias('asia', 'cont:asia');
  alias('europe', 'cont:europe');
  alias('oceania|pacific|the pacific|pacific islands', 'cont:oceania');
  alias('antarctica', 'cont:antarctica');

  // Canonical names, countries last: where a name is both a country and a
  // region ("Antarctica", "Micronesia") the country is the safer reading,
  // and a block on the region that contains it still covers it.
  Object.keys(SUBREGIONS).forEach(function (k) { ALIAS[slug(SUBREGIONS[k][0])] = 'sub:' + k; });
  Object.keys(GROUPS).forEach(function (k) { ALIAS[slug(GROUPS[k][0])] = 'grp:' + k; });
  Object.keys(COUNTRY_NAME).forEach(function (code) {
    ALIAS[slug(COUNTRY_NAME[code])] = code;
    ALIAS[slug(code)] = ALIAS[slug(code)] || code;
  });

  var UNAVAILABLE = new Set([
    'unknown', 'not available', 'unavailable', 'location unavailable',
    'no location', 'none', 'not specified', 'not disclosed', 'hidden',
    'n a', 'null', 'undisclosed', 'location not available'
  ]);

  /**
   * Turn a raw location string into a target id.
   * Returns null for empty, 'unavailable' for X's explicit "we don't know",
   * or 'label:<slug>' when it is a region name we have never seen before —
   * which is the whole point: an unmapped subregion still round-trips.
   */
  function parseLocation(raw) {
    if (raw == null) return null;
    var s = String(raw).trim();
    if (!s) return null;
    for (var i = 0; i < STRIP.length; i++) s = s.replace(STRIP[i], '').trim();
    // "Berlin, Germany" / "Germany · EU" -> try the whole thing, then each part
    var candidates = [s].concat(s.split(/\s*[,·|/]\s*/));
    for (var c = 0; c < candidates.length; c++) {
      var sl = slug(candidates[c]);
      if (!sl) continue;
      if (UNAVAILABLE.has(sl)) return 'unavailable';
      if (ALIAS[sl]) return ALIAS[sl];
      // bare ISO code
      var up = candidates[c].trim().toUpperCase();
      if (up.length === 2 && COUNTRY_NAME[up]) return up;
    }
    return 'label:' + slug(s);
  }

  TBR.regions = {
    SUBREGIONS: SUBREGIONS,
    CONTINENTS: CONTINENTS,
    GROUPS: GROUPS,
    COUNTRY_NAME: COUNTRY_NAME,
    COUNTRY_SUB: COUNTRY_SUB,
    SUB_CODES: SUB_CODES,
    CONT_CODES: CONT_CODES,
    codesFor: codesFor,
    labelFor: labelFor,
    parseLocation: parseLocation,
    slug: slug,
    countryCodes: function () { return Object.keys(COUNTRY_NAME).sort(); }
  };
})();

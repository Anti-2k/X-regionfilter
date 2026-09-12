/* Drives the real content script against synthetic X markup in happy-dom. */
import { test, expect } from 'bun:test';
import { Window } from 'happy-dom';
import vm from 'node:vm';
import fs from 'fs';

const SRC = ['src/regions.js', 'src/settings.js', 'src/matcher.js', 'src/content.js']
  .map((f) => fs.readFileSync(f, 'utf8'));

/* regions.js in this file's own scope, so tests can assert on what the
 * content script extracted (its own TBR lives inside the vm context). */
const REGIONS = (() => {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync('src/regions.js', 'utf8'), ctx);
  return ctx.TBR.regions;
})();

function deepMerge(a, b) {
  const out = structuredClone(a);
  for (const k of Object.keys(b || {})) {
    out[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])
      ? deepMerge(out[k] || {}, b[k]) : b[k];
  }
  return out;
}

async function run({ url = 'https://x.com/home', settings = {}, cache = {}, html }) {
  const w = new Window({ url });
  w.console = console;
  const base = deepMerge({
    enabled: true,
    blocked: ['RU'],
    sources: { passive: false, active: false, dom: false, selfReported: false },
    display: { blankWhilePending: false, pendingTimeoutMs: 400 }
  }, settings);

  const store = { settings: base };
  const sent = [];
  w.browser = {
    storage: {
      local: {
        get: (k) => Promise.resolve(k ? { [k]: store[k] } : store),
        set: (o) => { Object.assign(store, o); return Promise.resolve(); }
      },
      onChanged: { addListener() {} }
    },
    runtime: {
      getURL: (p) => 'moz-extension://test/' + p,
      onMessage: { addListener() {} },
      sendMessage: (m) => {
        sent.push(m);
        if (m.type === 'get') {
          const items = {};
          for (const h of m.handles) items[h] = cache[h] || null;
          return Promise.resolve({ items });
        }
        return Promise.resolve({});
      }
    },
    tabs: { query: () => Promise.resolve([]), sendMessage: () => Promise.resolve() }
  };

  // happy-dom windows do not carry the JS intrinsics as own properties, and
  // vm.createContext uses the object as-is for the global.
  for (const k of ["Object","Array","JSON","Promise","Set","Map","WeakMap","WeakSet",
    "String","Number","Boolean","Math","Date","RegExp","Error","TypeError","Symbol",
    "Function","structuredClone","parseInt","parseFloat","isNaN","Intl"]) {
    if (w[k] === undefined) w[k] = globalThis[k];
  }
  const ctx = vm.createContext(w);
  for (const code of SRC) vm.runInContext(code, ctx);
  await new Promise((r) => setTimeout(r, 20));
  w.document.body.innerHTML = html;
  await new Promise((r) => setTimeout(r, 120));

  const d = w.document;
  const res = {
    cell: (i = 0) => d.querySelectorAll('[data-testid="cellInnerDiv"]')[i].getAttribute('data-tbr'),
    quote: () => d.querySelector('div[role="link"]').getAttribute('data-tbr-quote'),
    note: () => (d.querySelector('.tbr-note') || {}).textContent,
    sent,
    close: () => w.happyDOM.close()
  };
  return res;
}

const userName = (h) =>
  `<div data-testid="User-Name"><a href="/${h}"><span>${h}</span></a>` +
  `<a href="/${h}/status/1"><time datetime="2026-01-01"></time></a></div>`;

function tweet({ author, quoted, reposter, focused }) {
  return `<div data-testid="cellInnerDiv"><article data-testid="tweet">
    ${reposter ? `<div data-testid="socialContext"><a href="/${reposter}"><span>${reposter} reposted</span></a></div>` : ''}
    ${focused
      ? `<div data-testid="User-Name"><a href="/${author}"><span>${author}</span></a></div>`
      : userName(author)}
    <div data-testid="tweetText">hello</div>
    ${quoted ? `<div role="link" tabindex="0">${userName(quoted)}<div>quoted text</div></div>` : ''}
  </article></div>`;
}

const RU = { target: 'RU', raw: 'Russia', kind: 'country', source: 'api-about' };
const EE = { target: 'sub:europe/eastern', raw: 'Eastern Europe', kind: 'region', source: 'api-about' };
const DE = { target: 'DE', raw: 'Germany', kind: 'country', source: 'api-about' };

test('hides a tweet whose author is in a blocked country', async () => {
  const r = await run({ cache: { bad: RU }, html: tweet({ author: 'bad' }) });
  expect(r.cell()).toBe('hidden');
  r.close();
});

test('leaves everyone else alone', async () => {
  const r = await run({ cache: { good: DE }, html: tweet({ author: 'good' }) });
  expect(r.cell()).toBe('ok');
  r.close();
});

test('placeholder mode collapses instead of removing', async () => {
  const r = await run({
    settings: { display: { mode: 'placeholder' } },
    cache: { bad: RU }, html: tweet({ author: 'bad' })
  });
  expect(r.cell()).toBe('collapsed');
  expect(r.note()).toContain('@bad');
  expect(r.note()).toContain('Russia');
  r.close();
});

test('hides only the embedded quote by default', async () => {
  const r = await run({ cache: { bad: RU, good: DE }, html: tweet({ author: 'good', quoted: 'bad' }) });
  expect(r.cell()).toBe('ok');
  expect(r.quote()).toBe('quote-hidden');
  r.close();
});

test('can hide the whole quoting tweet instead', async () => {
  const r = await run({
    settings: { surfaces: { quotedHidesHost: true } },
    cache: { bad: RU, good: DE }, html: tweet({ author: 'good', quoted: 'bad' })
  });
  expect(r.cell()).toBe('hidden');
  r.close();
});

test('quote embeds can be left alone entirely', async () => {
  const r = await run({
    settings: { surfaces: { quoted: false } },
    cache: { bad: RU, good: DE }, html: tweet({ author: 'good', quoted: 'bad' })
  });
  expect(r.cell()).toBe('ok');
  expect(r.quote()).toBe(null);
  r.close();
});

test('hides a repost made by a blocked account', async () => {
  const r = await run({ cache: { bad: RU, good: DE }, html: tweet({ author: 'good', reposter: 'bad' }) });
  expect(r.cell()).toBe('hidden');
  r.close();
});

test('reposts of a blocked author can be exempted', async () => {
  const r = await run({
    settings: { surfaces: { retweets: false } },
    cache: { bad: RU, good: DE }, html: tweet({ author: 'bad', reposter: 'good' })
  });
  expect(r.cell()).toBe('ok');
  r.close();
});

test('the tweet you opened by link is never unlisted by default', async () => {
  const r = await run({
    url: 'https://x.com/bad/status/1', cache: { bad: RU },
    html: tweet({ author: 'bad', focused: true })
  });
  expect(r.cell()).toBe('ok');
  r.close();
});

test('replies under that tweet still get unlisted', async () => {
  const r = await run({
    url: 'https://x.com/good/status/1', cache: { bad: RU, good: DE },
    html: tweet({ author: 'good', focused: true }) + tweet({ author: 'bad' })
  });
  expect(r.cell(0)).toBe('ok');
  expect(r.cell(1)).toBe('hidden');
  r.close();
});

test('a blocked account’s own profile is not gutted', async () => {
  const r = await run({
    url: 'https://x.com/bad', cache: { bad: RU }, html: tweet({ author: 'bad' })
  });
  expect(r.cell()).toBe('ok');
  r.close();
});

test('but their tweets elsewhere on a profile page still go', async () => {
  const r = await run({
    url: 'https://x.com/good', cache: { bad: RU }, html: tweet({ author: 'bad' })
  });
  expect(r.cell()).toBe('hidden');
  r.close();
});

/* --- the subregion edge case ------------------------------------------- */

test('region that merely overlaps the blocklist is shown by default', async () => {
  const r = await run({ cache: { x: EE }, html: tweet({ author: 'x' }) });
  expect(r.cell()).toBe('ok');
  r.close();
});

test('…hidden when you ask for that', async () => {
  const r = await run({
    settings: { policy: { ambiguous: 'block' } },
    cache: { x: EE }, html: tweet({ author: 'x' })
  });
  expect(r.cell()).toBe('hidden');
  r.close();
});

test('…or marked', async () => {
  const r = await run({
    settings: { policy: { ambiguous: 'flag' } },
    cache: { x: EE }, html: tweet({ author: 'x' })
  });
  expect(r.cell()).toBe('flagged');
  expect(r.note()).toContain('Unclear location');
  r.close();
});

test('a region fully inside the blocklist is not ambiguous at all', async () => {
  const r = await run({
    settings: { blocked: ['sub:europe/eastern'] },
    cache: { x: EE }, html: tweet({ author: 'x' })
  });
  expect(r.cell()).toBe('hidden');
  r.close();
});

test('blocking a region covers a country reported inside it', async () => {
  const r = await run({
    settings: { blocked: ['sub:europe/eastern'] },
    cache: { bad: RU }, html: tweet({ author: 'bad' })
  });
  expect(r.cell()).toBe('hidden');
  r.close();
});

test('an unmapped location X invented round-trips as its own filter', async () => {
  const odd = { target: 'label:some new bloc', raw: 'Some New Bloc', kind: 'region', source: 'dom-about' };
  const shown = await run({ cache: { x: odd }, html: tweet({ author: 'x' }) });
  expect(shown.cell()).toBe('ok');
  shown.close();

  const hidden = await run({
    settings: { blocked: ['label:some new bloc'] },
    cache: { x: odd }, html: tweet({ author: 'x' })
  });
  expect(hidden.cell()).toBe('hidden');
  hidden.close();
});

test('“location unavailable” is its own policy, not a country', async () => {
  const rec = { target: 'unavailable', raw: 'Location unavailable', kind: 'region', source: 'dom-about' };
  const a = await run({ cache: { x: rec }, html: tweet({ author: 'x' }) });
  expect(a.cell()).toBe('ok');
  a.close();
  const b = await run({
    settings: { policy: { unknown: 'block' } }, cache: { x: rec }, html: tweet({ author: 'x' })
  });
  expect(b.cell()).toBe('hidden');
  b.close();
});

/* --- overrides, allowlist, user cells ----------------------------------- */

test('allowlist beats the blocklist', async () => {
  const r = await run({ settings: { allow: ['bad'] }, cache: { bad: RU }, html: tweet({ author: 'bad' }) });
  expect(r.cell()).toBe('ok');
  r.close();
});

test('a per-account override beats whatever X said', async () => {
  const r = await run({
    settings: { overrides: { good: 'RU' } }, cache: { good: DE }, html: tweet({ author: 'good' })
  });
  expect(r.cell()).toBe('hidden');
  r.close();
});

test('account suggestions are unlisted too', async () => {
  const r = await run({
    cache: { bad: RU },
    html: '<div data-testid="cellInnerDiv"><div data-testid="UserCell"><a href="/bad"><span>bad</span></a></div></div>'
  });
  expect(r.cell()).toBe('hidden');
  r.close();
});

test('nothing is touched while filtering is off', async () => {
  const r = await run({ settings: { enabled: false }, cache: { bad: RU }, html: tweet({ author: 'bad' }) });
  expect(r.cell()).toBe(null);
  r.close();
});

test('an unknown author is asked about, then left alone', async () => {
  const r = await run({ cache: {}, html: tweet({ author: 'mystery' }) });
  const asked = r.sent.find((m) => m.type === 'get');
  expect(asked.handles).toContain('mystery');
  expect(r.cell()).toBe('ok');
  r.close();
});

/* ------------------------------------------- "About this account" panel ---
 *
 * X renders each row's label and value in SEPARATE elements, so textContent
 * concatenates them with no separator at all:
 *
 *   "Date joinedSeptember 2022Account based inUnited StatesVerifiedSince…"
 *
 * Any regex with a bounded character class over that string runs straight past
 * the value and into the following rows. That shipped once and cached garbage
 * for a fortnight. These tests exist to catch that whole class of bug: every
 * one asserts the extracted string is the value EXACTLY, and the invariant
 * test below asserts it still maps to a real country rather than a label:.   */

const aboutPanel = (rows, pretty) => {
  const cell = (t) => `<div><span>${t}</span></div>`;
  const row = ([k, v]) => `<div>${cell(k)}${cell(v)}</div>`;
  return pretty
    ? `<div role="dialog">\n  ${rows.map(row).join('\n  ')}\n</div>`
    : `<div role="dialog">${rows.map(row).join('')}</div>`;
};

/* The exact panel X shows for @25YearsAgoLive. */
const REAL_PANEL = [
  ['Date joined', 'September 2022'],
  ['Account based in', 'United States'],
  ['Verified', 'Since April 2024'],
  ['Last on', 'September 2022'],
  ['Connected via', 'United States App Store']
];

async function aboutPut(rows, opts = {}) {
  const r = await run({
    url: 'https://x.com/' + (opts.handle || 'someone'),
    settings: { sources: { dom: true, appStore: opts.appStore !== false } },
    html: aboutPanel(rows, opts.pretty)
  });
  const put = r.sent.find((m) => m.type === 'put');
  r.close();
  return put ? put.items[0] : null;
}

test('reads the disclosed country out of the real panel', async () => {
  expect(await aboutPut(REAL_PANEL, { handle: '25yearsagolive' })).toMatchObject({
    handle: '25yearsagolive', raw: 'United States', kind: 'country', source: 'dom-about'
  });
});

test('markup whitespace does not change what is read', async () => {
  const tight = await aboutPut(REAL_PANEL);
  const pretty = await aboutPut(REAL_PANEL, { pretty: true });
  expect(pretty.raw).toBe('United States');
  expect(pretty.raw).toBe(tight.raw);
});

/* The value must never absorb the row that follows it, whatever that row is. */
const NEXT_ROWS = [
  ['Verified', 'Since April 2024'],
  ['Connected via', 'United States App Store'],
  ['Last on', 'September 2022'],
  ['Also known as', 'Germany'],                 // a country name in the next row
  ['Note', 'x'.repeat(200)],                    // long enough to blow any {2,60}
  ['', 'United Kingdom']                        // value-only row, no label
];

for (const next of NEXT_ROWS) {
  test(`value is exact when followed by ${JSON.stringify(next[0] || next[1].slice(0, 12))}`, async () => {
    const got = await aboutPut([
      ['Date joined', 'September 2022'],
      ['Account based in', 'United States'],
      next
    ]);
    expect(got.raw).toBe('United States');
  });
}

/* The structural invariant: whatever we pull out of the panel has to survive
 * parseLocation as a real place. A label: target means we grabbed junk. */
const PANEL_COUNTRIES = ['United States', 'India', 'Germany', 'United Kingdom',
  'Japan', 'Brazil', 'South Africa', 'United Arab Emirates'];

for (const country of PANEL_COUNTRIES) {
  test(`"${country}" from the panel maps to a real country, not a label:`, async () => {
    const got = await aboutPut([
      ['Date joined', 'September 2022'],
      ['Account based in', country],
      ['Verified', 'Since April 2024'],
      ['Connected via', 'Ireland App Store']
    ]);
    expect(got.raw).toBe(country);
    const target = REGIONS.parseLocation(got.raw);
    expect(target).not.toMatch(/^label:/);
    expect(target).toMatch(/^[A-Z]{2}$/);
    expect(got.kind).toBe('country');
  });
}

test('a disclosed region is recorded as a region, not a country', async () => {
  const got = await aboutPut([['Account based in', 'Southeast Asia']]);
  expect(got).toMatchObject({ raw: 'Southeast Asia', kind: 'region', source: 'dom-about' });
});

test('an inline "Based in: X" row still works', async () => {
  const r = await run({
    url: 'https://x.com/someone',
    settings: { sources: { dom: true } },
    html: '<div role="dialog"><div><span>Based in: United States</span></div></div>'
  });
  expect(r.sent.find((m) => m.type === 'put').items[0].raw).toBe('United States');
  r.close();
});

test('a panel with no location row reports nothing', async () => {
  expect(await aboutPut([['Date joined', 'September 2022'], ['Verified', 'Since April 2024']]))
    .toBeNull();
});

/* ----------------------------------------- "Connected via" App Store fallback */

test('falls back to the App Store country when none is disclosed', async () => {
  expect(await aboutPut([
    ['Date joined', 'September 2022'],
    ['Verified', 'Since April 2024'],
    ['Connected via', 'United States App Store']
  ])).toMatchObject({ raw: 'United States', kind: 'country', source: 'dom-appstore' });
});

for (const suffix of ['App Store', 'Play Store', 'Google Play']) {
  test(`strips the "${suffix}" suffix`, async () => {
    const got = await aboutPut([['Connected via', `Japan ${suffix}`]]);
    expect(got.raw).toBe('Japan');
    expect(got.source).toBe('dom-appstore');
  });
}

test('a disclosed country always wins over the App Store row', async () => {
  const got = await aboutPut(REAL_PANEL);
  expect(got.source).toBe('dom-about');
  expect(got.raw).toBe('United States');
});

test('the disclosed country wins even when App Store disagrees', async () => {
  const got = await aboutPut([
    ['Account based in', 'India'],
    ['Connected via', 'United States App Store']
  ]);
  expect(got).toMatchObject({ raw: 'India', source: 'dom-about' });
});

test('the App Store fallback can be switched off', async () => {
  expect(await aboutPut([['Connected via', 'United States App Store']], { appStore: false }))
    .toBeNull();
});

test('"Connected via" without a store suffix is ignored', async () => {
  expect(await aboutPut([['Connected via', 'the web app']])).toBeNull();
});

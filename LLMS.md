# LLMS.md — maintenance manual for agents

Firefox MV3 extension that unlists tweets on x.com by author region. Read this
before editing. `README.md` is the user-facing doc; this is the working manual.

Repo: <https://github.com/Anti-2k/X-regionfilter>. Signed builds are distributed
as unlisted AMO releases, not through the public add-ons directory.

## Environment facts (this machine)

- **No `node`.** Use `bun` for everything: `bun test`, `bun -e '...'` for scripts.
- **No `zip`.** `7z` exists if you need one by hand; otherwise use `web-ext build`.
- **web-ext comes from nix**, not npm: `nix-shell -p web-ext --run '<cmd>'`.
- **`web-ext-config.mjs` must stay `.mjs`.** web-ext 8 warns on `.js` and
  mis-parses `.cjs` (`UsageError: "module.exports" must be camel case`). Verified.
- **`bun run <script>` does not forward auto-loaded `.env` to subprocesses.**
  Verified. Use `bun --env-file=.env run <script>` or shell sourcing
  (`set -a; . ./.env; set +a`), which is what `sign:nix` does. `sign:nix` reads
  `$WEB_EXT_ENV_FILE` if set, so the credentials can live outside the project
  (e.g. an agenix secret at `/run/agenix/amo-web-ext`) instead of in a plaintext
  `.env`.
- `.gitignore` covers `.env` (holds AMO signing credentials — never commit it),
  `node_modules/` and `web-ext-artifacts/`. Signed `.xpi` files are build output;
  publish them as GitHub releases rather than committing them.

## Non-negotiable invariants

1. **Unlist, never block.** Only remove entries from lists. Never prevent
   navigation, never rewrite links, never touch a page the user asked for. The
   `focusedTweet` and `profileTweets` surfaces default **off** for this reason —
   do not flip those defaults.
2. **No bundler, minifier, transpiler or template engine, ever.** Every shipped
   file is hand-written and shipped verbatim. This is what lets the AMO submission
   answer "no" to the code-generation question and skip source-code review.
   Introducing a build step breaks that and is a policy problem, not just a
   technical one.
3. **No remote code, no new hosts.** `permissions` is `["storage"]` and
   `host_permissions` is x.com/twitter.com only. Adding permissions changes the
   AMO review path and the user-facing install prompt.
4. **Ambiguity is surfaced, never guessed.** See below. If you find yourself
   writing a heuristic to resolve a partial region match, stop.
5. **ES5-flavoured syntax in `src/`.** `var`, `function`, no optional chaining.
   Content-script files share one sandbox scope and re-declare `var TBR`;
   `const`/`let` would throw on re-declaration. Test files and `ui/` are free of
   this constraint (`ui/` runs as its own page; tests run in bun).

## Architecture

```
page world            isolated world             extension
─────────             ──────────────             ─────────
src/inject.js  <──►   src/content.js     <──►    src/background.js
patches fetch/XHR,    classifies DOM             location cache,
harvests locations,   entries, hides them        broadcasts updates
replays requests           │
                           └──► ui/popup.js, ui/options.js (own pages)
```

`src/regions.js`, `src/settings.js`, `src/matcher.js` are shared: listed in both
the background `scripts` array and the content-script `js` array, and loaded by
the UI pages via `<script src="../src/...">`. Anything added to them must run in
all three contexts — no DOM assumptions, no `browser.*` calls at load time.

`src/inject.js` runs in the page world twice over: declaratively via the
`world: "MAIN"` content script (FF 128+) and, as a fallback, injected as a script
tag by `content.js`. The `window.__tbrInjected` guard makes the second a no-op.

### Data flow for one tweet

1. `content.js` `sweep()` walks `article[data-testid="tweet"]` and
   `[data-testid="UserCell"]`.
2. `describeArticle()` extracts author / quoted author / reposter handles.
3. `verdictFor(handle)` → cache lookup via background (`type: 'get'`, batched
   60ms). Miss → `toPage({type:'lookup'})` and the entry is marked `pending`.
4. `inject.js` finds a location (passively or by replaying a request) →
   `{type:'locations'}` → content → background `{type:'put'}`.
5. Background parses the raw string with `regions.parseLocation`, applies source
   ranking, caches, broadcasts `{type:'updated'}` to every x.com tab.
6. Content re-runs `sweep()`; `matcher.evaluate()` returns
   `{action: 'allow'|'block'|'flag'}`; the entry gets `data-tbr="hidden"` /
   `"collapsed"` / `"flagged"` / `"ok"` and `src/styles.css` does the rest.

## Core contracts

### Target ids (`src/regions.js`)

Every blockable thing and every reported location is one string:

| Form | Example | `codesFor()` returns |
| --- | --- | --- |
| ISO 3166-1 alpha-2 | `"RU"` | `["RU"]` |
| M49 subregion | `"sub:europe/eastern"` | its 10 countries |
| Continent | `"cont:europe"` | every European country |
| Named bloc | `"grp:eu"` | the 27 member states |
| Unmappable string | `"label:some new bloc"` | `[]` — matched literally |
| Sentinel | `"unavailable"` | n/a — X explicitly disclosed nothing |

`parseLocation(raw)` turns anything X says into one of these. It strips prefixes
("Based in …"), normalises diacritics and punctuation, tries the whole string then
each comma/·/| separated part, and falls back to `label:<slug>` rather than
dropping the value. `labelFor(target)` is the inverse for display.

Name collisions ("Antarctica", "Micronesia" are both a country and a region)
resolve to the **country** — alias registration order at the bottom of
`regions.js` is load-bearing, countries last. Cyprus is deliberately added to
`CONT_CODES.europe` on top of its M49 home in Western Asia, so blocking Europe
fully contains the EU. Both are covered by tests.

### The matching rule (`src/matcher.js`)

Both sides collapse to a set of country codes:

- reported ⊆ blocked → `block`
- reported ∩ blocked = ∅ → `allow`
- partial overlap → **`policy.ambiguous`** (`allow` | `block` | `flag`)

Plus `policy.unmapped` for a `label:` target that isn't literally on the list, and
`policy.unknown` for `unavailable` / no record. All three default to `allow`.
`evaluate()` also returns a human-readable `why` used in placeholder tooltips —
keep it accurate, it's the only explanation a user gets.

### Location records

Produced by `inject.js` as `{handle, raw, kind, source, field}` where `kind` is
`'country' | 'region' | 'self'`. Stored by `background.js` as
`{target, raw, kind, source, field, ts, rank}`. `rankOf()` decides whether a new
sighting overwrites an old one: country 60 / region 50 / self 10, `+25` for
`dom-about`, `+20` for an about-style API op, `1000` for a user override. `self`
records are dropped entirely unless `sources.selfReported` is on.

### Messages

- content → background: `get`, `put`, `badge`, `cacheStats`, `cacheDump`,
  `clearCache`, `forget`
- background → content: `updated`
- popup → content: `pageStats`, `revealAll`, `rescan`
- content → page (`postMessage`, `{tbr:true, dir:'toPage'}`): `config`, `lookup`,
  `diag`
- page → content (`postMessage`, `{tbr:true}`): `ready`, `locations`,
  `lookupFailed`, `diag`

### Settings

`src/settings.js` `DEFAULTS` is the schema. `merge()` only keeps keys that exist
in the defaults (`overrides` is exempt, being a free-form map), so **a new setting
must be added to `DEFAULTS` or it will be silently discarded on save.**

## Common tasks

**Add a country, region or bloc.** `src/regions.js`: add to the `SUBREGIONS`
table (`'CC:Name'`, comma separated) or to `GROUPS`. Add aliases with
`alias('name one|name two', target)` if X might word it differently. The options
UI builds itself from these tables — no UI change needed. `test/regions.test.js`
will catch a code with no subregion, a group with a bad code, or a label that
doesn't round-trip.

**Add a surface.** Four places: `DEFAULTS.surfaces` in `settings.js`; the
`SURFACES` array in `ui/options.js` (label); `pageContext()` / `surfaceEnabled()`
in `content.js` if it's a new page type; the check list inside `processArticle()`
if it's a new thing to test on an existing entry. Then a case in
`test/dom.test.js`.

**Add a location source.** Emit `{handle, raw, kind, source}` from `inject.js`
and give the new `source` string a rank in `background.js` `rankOf()`. Add a
toggle to `DEFAULTS.sources` and the `SOURCES` array in `ui/options.js`.

**Touch the options tree.** `ui/options.js` repaints checkbox state **in place**
(`paint()` / `repaint()`), it does not rebuild the tree. Rebuilding collapses every
`<details>` the user had open and loses their scroll position — that was a real
bug. `renderPlaces()` is the only full rebuild and is reserved for load, import
and clear-all. `applySearch()` snapshots `open` state into `dataset.prevOpen` when
a search starts and restores it when the box is cleared. `test/options.test.js`
guards all of this, including asserting the same DOM node survives a toggle.

**Change the icon.** `icons/icon.svg` is the 48px-and-up art; `icons/icon-small.svg`
is a simplified version (no meridian, heavier strokes) because the detailed one
turns to mush at 16px. PNGs are generated, not hand-drawn:
`magick -density 600 -background none icons/icon.svg -resize 48x48 icons/icon-48.png`
(sizes 48/96/128 from `icon.svg`, 16/32 from `icon-small.svg`). Note magick can
hang on some invocations here — always run it under `timeout`.

**Add a setting with UI.** `DEFAULTS` → a control in `ui/options.html` → wire it
in `renderAll()` and an event listener in `ui/options.js`. `save()` merges and
persists; `content.js` picks it up through `TBR.settings.onChange`, which clears
caches and re-sweeps.

## When X changes its DOM

The load-bearing selectors are all in `src/content.js`. In rough order of how
likely they are to break:

| Purpose | Selector |
| --- | --- |
| entry container | `[data-testid="cellInnerDiv"]` |
| tweet | `article[data-testid="tweet"], article[role="article"]` |
| author block | `[data-testid="User-Name"]` |
| quoted tweet | `div[role="link"]` containing a `User-Name` |
| repost header | `[data-testid="socialContext"]` |
| account row | `[data-testid="UserCell"]` |
| focused tweet | *absence* of `a[href*="/status/"] time` in the article |

That last one is the subtlest: on a status page every reply's timestamp is a link
containing `<time>`, and the tweet you opened is the one where it isn't. If focus
detection breaks, opened tweets start disappearing — check this first.

Handles come from `href` via `handleFromHref()`, which rejects reserved paths
(`i`, `home`, `search`, …). Repost detection ignores anchors whose href contains
`/status/` so "Show this thread" isn't mistaken for a reposter.

To repair: update the selector, then run `bun test` — `test/dom.test.js` builds
synthetic markup matching the table above, so **also update the `tweet()` and
`userName()` helpers in that file** to match X's new shape, or the tests will keep
passing against markup that no longer exists.

## Testing

```sh
bun test          # 35 tests, ~4s
```

- `test/regions.test.js` — parsing, containment, ambiguity, plus invariants over
  the whole taxonomy (every country in exactly one subregion, every label
  round-trips).
- `test/dom.test.js` — runs the **real** content script against synthetic markup
  in happy-dom and asserts what gets hidden.
- `test/options.test.js` — runs the **real** settings page against the actual
  `options.html` body, and asserts the tree does not collapse when you tick a box.

The DOM harness has two non-obvious pieces, both required:

1. Scripts are evaluated with `node:vm` (`vm.runInContext`), because happy-dom 20
   does not execute inline `<script>` elements.
2. The window must be seeded with JS intrinsics (`Object`, `Promise`, `Set`, …)
   before `vm.createContext`, or the scripts die on `Object.create`.

`run({url, settings, cache, html})` stubs `browser.storage`/`runtime`/`tabs` and
returns `{cell(i), quote(), note(), sent}`. Tests set
`sources: {active: false}` so unresolved handles settle immediately instead of
waiting on the pending timeout. Add cases by calling `tweet({author, quoted,
reposter, focused})`.

## Build, lint, release

```sh
web-ext lint --self-hosted    # same validator AMO runs; keep it at 0/0
web-ext build                 # -> web-ext-artifacts/regionfilter_for_x-<v>.zip
web-ext run                   # live-reloading dev Firefox
```

`web-ext-config.mjs` keeps `test/`, `node_modules/`, docs and lockfiles out of
every artifact. Verify after changing it: a package should contain exactly 20 files
(14 code/markup + 6 icon files).

Release checklist:

1. `bun test` green, `web-ext lint --self-hosted` 0 errors / 0 warnings.
2. Bump `version` in **both** `manifest.json` and `package.json`. AMO rejects a
   re-upload of an existing version.
3. `bun run sign:nix` (sources `.env`, signs unlisted, downloads the `.xpi` into
   `web-ext-artifacts/`).
4. Install via `about:addons` → gear → Install Add-on From File.

Lint and AMO should both read 0 errors / 0 warnings. If `data_collection_permissions`
warnings reappear, a manifest minimum drifted below the version that supports the
key: `gecko.strict_min_version` must be `140.0`+ and
`gecko_android.strict_min_version` `142.0`+.

## Things that look like bugs but aren't

- **A partial region match doesn't hide anything by default.** Intended. See
  invariant 4.
- **The focused tweet and an author's own profile aren't filtered.** Intended.
  See invariant 1.
- **Nothing hides on a cold profile for the first few seconds.** No locations are
  cached yet; entries sit `pending`, then fall back to `policy.unknown`.
- **`rankOf` refuses to overwrite a fresher, higher-ranked record.** Intended —
  a passive sighting shouldn't clobber what the About panel said.
- **`label:` targets have no country codes.** Intended — they can only ever match
  themselves, literally.

# AGENTS.md: maintenance manual

Firefox MV3 extension that unlists posts on x.com by where their author is
based. `README.md` is the user doc; this is the working manual. Read it before
editing.

Repo: <https://github.com/Anti-2k/X-regionfilter>. Signed builds go out as
unlisted AMO releases.

## Environment (this machine)

- **No `node`, no `zip`.** Use `bun` for scripts; `web-ext build` for packages.
- **web-ext comes from nix**: `nix-shell -p web-ext --run '<cmd>'`.
- `web-ext-config.mjs` must stay `.mjs` (web-ext 8 mis-parses `.cjs`).
- `bun run <script>` does not forward `.env` to subprocesses; `sign:nix`
  sources it itself and reads `$WEB_EXT_ENV_FILE` if set.
- `.env` holds AMO credentials. Never commit it.

## Invariants

1. **Unlist, never block.** Only hide entries in lists. Never stop
   navigation, rewrite links or touch a page the user asked for. The opened
   post and an author's own profile are unfiltered by default; keep it so.
2. **No build step.** Every shipped file is hand-written and shipped as is,
   so the AMO "generated code" answer stays "no". No bundler, minifier,
   transpiler, framework.
3. **No new required permissions or hosts.** `permissions: ["storage"]`,
   hosts are x.com/twitter.com, `data_collection_permissions.required` is
   `none`. Network requests go to x.com and abs.twimg.com (X's own bundle,
   for query-id recovery) only, plus the sync database when the user connects
   one: that host and `websiteContent` are optional permissions granted from
   the options page, never at install.
4. **Ambiguity goes to the user.** A region that only partly overlaps the
   list follows `settings.unclear`; never add a heuristic that guesses.
5. **ES5-style syntax in `src/`.** `var`, `function`, no optional chaining.
   The shared files re-declare `var TBR` in one content-script scope.

## Where locations come from

X shows where an account is based only on its "About this account" page,
which is backed by one GraphQL query:

```
GET /i/api/graphql/<queryId>/AboutAccountQuery?variables={"screenName":"name"}
headers: authorization: Bearer <public web token>, x-csrf-token: <ct0 cookie>,
         x-twitter-auth-type: OAuth2Session, x-twitter-active-user: yes
-> data.user_result_by_screen_name.result            (__typename "User")
     .about_profile.account_based_in   "United States" | absent
     .about_profile.source             "United States App Store" | absent
     .about_profile.location_accurate  false when X suspects a VPN/proxy
```

Verified live 2026-10-01 (queryId `TzOG2twZEfhr9KmClvVVqA`). No
`x-client-transaction-id` is needed. Timeline payloads carry only the
free-text profile location (`user.location.location`); they do **not**
include `about_profile`, so every author must be looked up individually.

**Rate limit: 50 per 15 minutes per account**, reported in
`x-rate-limit-limit/remaining/reset` (reset is epoch seconds). X's own
About-page requests count against the same budget.

**Query id rotation.** X changes query ids on deploys. `page.js` learns the
current id from X's own requests, and on a 400/404 recovers it from the lazy
chunk: the inline webpack runtime maps `<chunkId>:"shared~bundle.UserAbout~loader.AboutAccount"`
and `<chunkId>:"<hash>"`; the file is
`https://abs.twimg.com/responsive-web/client-web/<name>.<hash>a.js` and
contains `params:{id:"<queryId>",metadata:{},name:"AboutAccountQuery"`. If
the "about" feature moves to a differently named chunk, update the regex in
`discover()`.

Logged-out pages run a different app (`abs.twimg.com/x-web/…`); logged-in
pages still use `responsive-web`. The extension only matters logged in.

## Architecture

```
page world (MAIN)        content script (isolated)          background
src/page.js     <-msg->  src/content.js          <-msg->    src/background.js
AboutAccountQuery        finds entries, decides,            cache (storage.local
requests + observes      hides; lookup queue,               "locations"), shared
X's own ones             priority by viewport               rate budget, broadcast,
                                                            optional sync database
```

Shared files: `src/regions.js` (taxonomy + parsing), `src/settings.js`
(schema/storage) and `src/matcher.js` load in the background and the content
script, in that order; the options page loads regions + settings, the popup
settings only. Nothing in them may touch the DOM or call `browser.*` at load
time.

### One author, start to finish

1. `content.js` `sweep()` walks `article[data-testid="tweet"]` and
   `[data-testid="UserCell"]`; `describe()` pulls author, quoted author,
   reposter, and whether this is the opened post.
2. `verdictFor(handle)`: allowlist → override → known record → otherwise
   `need()`: batched `get` to background (40 ms). With a sync database
   connected, background asks it about the batch's misses (one request, up
   to 1.5 s) before answering.
3. Cache miss → handle goes into `want`. `pump()` asks background for a
   `lease` (at most 2 in flight per tab), on-screen handles first; handles
   scrolled out of the DOM are dropped from the queue.
4. Granted → `page.js` runs the query → `{type:'result', handle, info,
   limit}` → content → background `result`: stores raw facts, updates the
   budget from the headers, broadcasts `updated` to every x.com tab.
5. `matcher.evaluate()` → allow / block / flag; the entry gets `data-tbr`
   and `src/styles.css` does the rest.

While a lookup is really on its way the entry is `pending` (blank, if
`holdBlank`) for up to `HOLD_MS` = 2.5 s. When the budget is spent, entries
are never held; they follow `settings.unknown` until an answer arrives.

### Budget (background.js)

`budget().left = remaining − RESERVE(5) − in-flight`; before X has reported
any headers it allows `UNKNOWN_BURST` = 3. A 429 zeroes it until reset. The
budget object lives in memory and `storage.local` (`limit`), because Firefox
unloads the event page when idle.

### Cache records

Stored raw, keyed by lowercase handle, under `storage.local.locations`:
`{basedIn, store, accurate, ts}` or `{missing:true, ts}`. `view()` turns a
record into what the matcher sees under the current source toggles, so
flipping "Account based in" / "Connected via" takes effect without new
lookups. TTLs: 30 days with a based-in, 7 days without, 1 day for missing
accounts. Records from the sync database carry `src:'db'` and the server's
`exp`, which replaces the local TTL; `up:1` marks a record the database
already has. `seen` counts raw based-in strings for the options page.

### Sync database (background.js)

Off unless `storage.local.db` = `{url, token, name, canWrite}` is set, which
only the options page's Connect does after `permissions.request` for the
host and `websiteContent` and a `/v1/ping`. It lives outside `settings`
so an exported settings file never carries the token.

- `get`: local misses → one `/v1/lookup` → hits stored as above. Misses are
  not asked again for 5 min; any error backs off for 1 min. Never blocks a
  lookup on X for longer than the 1.5 s timeout.
- Uploads: every `result` from X, plus on each background start every record
  without `src`/`up` (backfill), in batches of 200. 403 → read-only, stop.
- `dbSyncedTo` remembers which server the `up` marks refer to; connecting a
  different one clears them so everything is offered again.
- Clearing the cache is local only. Clients never delete from the database.

### Messages

- content → background: `get`, `lease`, `result`, `queryId`, `badge`
- options/popup → background: `stats` (includes `db`), `clearCache`
- options → background: none for the database; it watches `storage.local.db`
- background → content: `updated`, `cleared`
- popup → content: `pageStats`, `revealAll`
- content ↔ page (`window.postMessage`, `tbr: 'content' | 'page'`):
  `lookup`, `queryId` / `ready`, `queryId`, `result`

### Settings

`DEFAULTS` in `src/settings.js` is the schema. `merge()` drops keys that
aren't in it (`overrides` is a free-form map), so **a new setting must be
added to `DEFAULTS`**. Options controls bind with `data-key="path.to.key"`;
`fillKeyed()` / `bindKeyed()` in `ui/options.js` handle them generically.

### The matching rule (src/matcher.js)

Both sides collapse to ISO country codes (`regions.codesFor`):
author ⊆ blocked → block; disjoint → allow; partial → `settings.unclear`.
Unrecognised wording becomes `label:<slug>` and only matches itself;
otherwise it follows `unclear`. No record or nothing disclosed → `unknown`.
`why` is shown as the placeholder tooltip; keep it accurate.

### Target ids (src/regions.js)

`"RU"` country · `"sub:europe/eastern"` M49 subregion · `"cont:europe"` ·
`"grp:eu"` named bloc · `"label:<slug>"` unrecognised · `"unavailable"`.
Name collisions resolve to the country (aliases registered countries last).
Cyprus is added to Europe so blocking Europe fully covers the EU.

## DOM selectors (src/content.js)

| Purpose | Selector / rule |
| --- | --- |
| entry container | `[data-testid="cellInnerDiv"]` |
| post | `article[data-testid="tweet"]` |
| author | first `[data-testid="User-Name"]` not inside the quote |
| quoted post | `div[role="link"]` containing a `User-Name` |
| repost header | `[data-testid="socialContext"]` inside an `a[href="/name"]`; "Pinned" uses the same testid with no link |
| account row | `[data-testid="UserCell"]` |
| opened post | `article[tabindex="-1"]`, or its own timestamp link ends in the URL's status id (links inside a quote ignored) |

All verified live 2026-10-01. Note X now gives the opened post a timestamp
link too, so the old "no `/status/` time link" rule no longer works.

The pass is idempotent: `sweep()` re-evaluates every visible entry and only
writes attributes that changed, so it can run on every mutation. It runs on
the next animation frame **or** a 120 ms timer, whichever is first, because
Firefox pauses animation frames in hidden tabs.

## Sync server (server/)

Optional Cloudflare Worker + D1 that shares location records between
installs; `server/README.md` has setup, the API and admin SQL. It is not part
of the extension package (`web-ext-config.mjs` ignores it) and the no-build
and ES5 rules don't apply to it.

- Clients read (`/v1/lookup`) and add newer records (`/v1/records`). There
  is no delete or edit endpoint; the owner manages data by hand.
- The server decides how long a record is served (`settings` table) and
  sends `exp`; the client doesn't judge a DB record's age.
- Each batch is one SQL statement over `json_each(?)`: D1's free plan allows
  50 queries per request.
- **Never commit credentials**: `server/wrangler.toml` (has the database
  id), tokens, `.dev.vars` are git-ignored. Only `wrangler.example.toml` is
  tracked. The repo is meant to go public.

Check it locally with a throwaway config outside the repo:
`wrangler d1 execute regionfilter --local --persist-to <dir> --file schema.sql`
then `wrangler dev --local --persist-to <dir>`.

## Checking changes

There are no automated tests. Check in a real logged-in Firefox:

```sh
web-ext run --firefox-profile <dev profile> --keep-profile-changes
```

What to look at: Home (placeholders mode makes hits visible), a status page
(opened post stays, replies filter), a profile (own posts stay), Following
tab reposts, `/i/connect_people` (account rows), opening an About page
(should cache that account without spending a lookup), the options page
Status box (budget, cache counts, locations seen).

Lookups are scarce. Use fixed locations (`@name = Country`) to exercise the
matching and hiding paths without spending budget.

X refuses logins from a browser driven over WebDriver (`navigator.webdriver`).
Log in to the dev profile with a normal Firefox launch first, then reopen it
with remote debugging.

## Build and release

```sh
web-ext lint --self-hosted    # keep at 0 errors / 0 warnings
web-ext build                 # -> web-ext-artifacts/
```

1. Lint clean, checked in a live session.
2. Bump `version` in **both** `manifest.json` and `package.json`.
3. `bun run sign:nix` (unlisted; downloads the `.xpi`).
4. Install via `about:addons` → gear → Install Add-on From File.

`gecko.strict_min_version` must stay ≥ 140.0 and `gecko_android` ≥ 142.0
for `data_collection_permissions`; `world: "MAIN"` content scripts need ≥ 128.

## Things that look like bugs but aren't

- New authors show normally when the budget is spent. They're filtered once
  looked up; the cache fills as you browse.
- A partial region match shows by default (`unclear: allow`).
- The opened post and an author's own profile aren't filtered by default.
- Accounts like @NASA have no "based in" at all; they follow `unknown`.

# Regionfilter for X

[github.com/Anti-2k/X-regionfilter](https://github.com/Anti-2k/X-regionfilter)

Hides tweets based on where their author is. You pick countries or regions; posts
from those places stop showing up in your feed.

**It unlists, it doesn't block.** Matching posts are removed from the lists you
scroll past — timeline, replies, search, notifications, quote embeds, account
suggestions. Nothing is actually blocked: the accounts still exist, their profiles
still open, links still work, and a tweet you deliberately click still loads. If
you go looking for something, you'll find it. You just won't be shown it.

---

## Installing

**The permanent way.** Grab the signed `.xpi` from the [Releases page](https://github.com/Anti-2k/X-regionfilter/releases), or from
[the AMO developer hub](https://addons.mozilla.org/developers/addons) (your add-on
→ Manage Status & Versions → click the version → download). Then, in Firefox:
`about:addons` → the gear icon → **Install Add-on From File…**. Survives restarts
like any normal extension.

**The quick way, for a look.** `about:debugging#/runtime/this-firefox` →
**Load Temporary Add-on…** → pick `manifest.json`. This disappears every time you
close Firefox — it's for testing, not for living with.

Needs Firefox 140 or newer (Firefox for Android 142+).

---

## Setting it up

Click the toolbar icon → **Settings…**. Five tabs.

### Places

The list of countries and regions you don't want to see. Search, or expand a
continent and tick things.

You can tick at any level. Ticking **Eastern Europe** covers all ten countries in
it; the individual countries then show up greyed out with a note saying what's
covering them. There's also a **Groups** section at the top for the blocs X
actually uses in practice — European Union, Middle East, Nordics, Sub-Saharan
Africa, Gulf states and so on.

Your current selections appear as removable chips at the top.

### Where it applies

Twelve switches for the twelve places a tweet can appear. Most are on. Three
worth knowing about:

- **Quote embeds** — when a blocked author is quoted inside someone else's tweet,
  the default hides just the quote box and leaves the tweet around it. Flip
  *"…and hide the whole quoting tweet"* if you'd rather lose the lot.
- **Reposts** — two separate switches. One for reposts *of* someone in a blocked
  region, one for anything reposted *by* an account in one.
- **Their own profile** and **the tweet you opened by link** are **off** by
  default. If you deliberately navigated somewhere, you get to see it. Turn them
  on if you want the filter to apply even then.

This tab also controls what a hidden entry looks like: gone entirely (default), or
collapsed to a one-line placeholder with a **Show** button that names the region.
The placeholder is worth trying for a few days — it shows you what you're
actually filtering out before you commit to the silent version.

### Unclear locations

**This is the tab that matters, and it's worth two minutes.**

X often doesn't say what country someone is in. It says a *region* — "Eastern
Europe", "the European Union", "Southeast Asia" — and nothing more specific. So
"is this author in a place I blocked?" doesn't always have a yes or no answer:

- You blocked **Eastern Europe**, X says **Russia** → hidden. Russia is in Eastern
  Europe, no ambiguity.
- You blocked **Russia**, X says **Western Europe** → shown. No overlap at all.
- You blocked **Russia**, X says **Eastern Europe** → **nobody can tell.** That
  account might be Russian. It might be Polish. The data doesn't say.

That last case is a genuine coin flip, so the extension refuses to guess and asks
you instead. Three options: **show it** (default, cautious), **hide it** (blunt —
you'll lose Poles along with Russians), or **show it but mark it** with a dashed
outline so you can see how often it's even coming up.

Two more settings work the same way, for when X reports a place the extension has
never heard of, and for when X discloses nothing at all. Both default to showing
the post.

### Per-account

Two lists. **Never hide these accounts** wins over everything — put people you
follow here. **Fixed locations** (`@someone = Germany`) overrides whatever X says
about that account and never expires; useful when X has someone plainly wrong, or
when you know better.

### Advanced

Where location data comes from (below), how long it's cached, a diagnostics
panel, and settings export/import.

---

## Why some posts take a second

X never puts an author's country in the page itself. It only exists inside X's own
API traffic and in the **About this account** panel. So the extension picks it up
four ways:

1. **Watching X's own traffic** as you scroll. Free, no extra requests, and it
   fills in quickly just from normal browsing. On by default.
2. **Asking about accounts it hasn't seen**, by reusing a request X itself has
   already made. This only works for request shapes X has performed at least once
   in the session — visiting any profile is usually enough.
3. **Reading the About panel** whenever you open one. The most reliable of the
   four.
4. **The account's self-written profile location.** Off by default: it's free text
   anyone can put anything in.

Everything found gets cached for two weeks and shared across tabs, so the same
account is only ever looked up once.

While an author is still unresolved, their post is held blank for a moment
(2.5 seconds by default) so something about to be hidden doesn't flash past first.
If nothing resolves in time, your *"X discloses no location"* policy applies. This
is why the first minute on a fresh profile is the slowest — after that, almost
everything is a cache hit.

**Diagnostics** in the Advanced tab shows what's working: how many responses have
been scanned, how many locations were found, which request shapes it learned. If
filtering seems inert, look there first.

---

## Troubleshooting

**Nothing is being hidden.** Check Diagnostics. If *locations found* is 0, the
extension hasn't learned anything about anyone yet — scroll a bit, or open one
account's *About this account* panel to prime it. If it's non-zero but nothing
hides, your blocklist probably doesn't overlap what X is reporting; switch
*Unclear locations* to **show but mark** for a while to see what's actually coming
through.

**Too much is being hidden.** Almost always the *Unclear locations* → **hide it**
setting. A region that merely overlaps your list catches everyone else in that
region too. Set it back to **show** or **mark**.

**Someone I follow got hidden.** Add them to *Never hide these accounts*.

**X changed its layout and everything broke.** Likely — X reshuffles its markup
regularly. See `LLMS.md`, which documents exactly which selectors are load-bearing
and how to repair them.

**Is anything sent anywhere?** No. Settings and the location cache live in your
browser's local extension storage. No servers, no analytics, no remote code. The
only network requests it ever makes are to X itself, replaying a request X already
made, and only when *Ask X's API* is on.

---

## Working on it

Needs [bun](https://bun.sh) and [web-ext](https://github.com/mozilla/web-ext).
On NixOS: `nix-shell -p web-ext`.

```sh
bun install
bun test              # 35 tests: taxonomy, matching, and the DOM engine
web-ext run           # live-reloading Firefox with the extension loaded
web-ext lint --self-hosted
web-ext build         # -> web-ext-artifacts/
```

To sign a new version: bump `version` in `manifest.json`, put your AMO API
credentials in `.env` (copy `.env.example`; it's gitignored), then
`bun run sign:nix`.

`LLMS.md` is the maintenance manual — architecture, contracts, how to add a
region or a surface, and how to fix things when X changes its DOM.

## License

MIT — see `LICENSE`.

## Layout

```
manifest.json
src/regions.js     country/region taxonomy and location-string parsing
src/matcher.js     the hide/show/mark decision
src/settings.js    schema, defaults, storage
src/inject.js      watches X's API traffic for author locations
src/content.js     decides which entries to unlist, and unlists them
src/background.js  shared location cache
ui/                settings page and toolbar popup
test/              bun tests
```

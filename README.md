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

Click the toolbar icon → **Settings**. It's one page, with a short hint under
every option.

**Places to hide.** Search, or expand a continent and tick things. Ticking a
region covers every country in it; those countries then show greyed out with
"via …". **Groups** has the blocs X tends to use: European Union, Middle East,
Nordics, Gulf states and so on.

**Where locations come from.** Two switches, both on by default:

- **Account based in**: the country or region X shows for the account. The
  main signal.
- **Connected via (App Store)**: the country of the app store the account
  uses. Only used when there's no "based in". It doesn't change with travel or
  VPNs, so it's a decent hint and a poor fact.

Turn both off and no lookups happen at all; only your fixed locations apply.

**Where to filter.** Feeds, replies, quoted posts, reposts and people lists are
on. **Their own profile** and **The post you opened** are off: if you went
somewhere on purpose, you see it.

**When it isn't clear.** X sometimes gives only a region. If you hid Russia
and X says "Eastern Europe", the account might be Russian or Polish, and
nothing in the data says which. So you choose: **Show** (default), **Show,
marked** (a dashed outline, handy for seeing how often it comes up), or
**Hide**. The same choice exists for accounts with **no location**: X shows
nothing, or they haven't been looked up yet.

**Looks.** Remove hidden posts entirely (default) or leave a one-line
**placeholder** with a Show button that names the place. Try the placeholder
for a few days to see what you're actually filtering.

**Accounts.** **Never hide** wins over everything. **Fixed locations**
(`@someone = Germany`) replace whatever X says.

**Status.** How many lookups are left, how many accounts are known, and every
location X has reported so far with how it was read.

---

## How it finds locations, and why it's gradual

X only shows where an account is based on its **About this account** page.
The extension asks X for that page's data, one account at a time, with your own
logged-in session, exactly as X's website does when you open an About page.

X allows **about 50 of those lookups every 15 minutes**. So:

- Posts on screen are looked up first. Ones you've scrolled past aren't.
- Every answer is cached for 30 days and shared across tabs, so each account
  is only looked up once.
- While a lookup is on its way, the post is held blank for up to 2.5 seconds
  so it doesn't flash past before hiding.
- When the 50 are used up, new authors show normally until X resets the count.
  They get filtered once they've been looked up.
- Opening someone's About page yourself also teaches the extension about them,
  at no cost.

The first sessions on a fresh install are the patchiest. It fills in quickly.

---

## Troubleshooting

**Nothing is being hidden.** Check the popup: are any places picked, and are
there lookups left? Settings → Status → *Locations seen so far* shows what X
has actually reported. If your list doesn't overlap any of it, nothing will
hide.

**Too much is being hidden.** Usually *When it isn't clear* set to **Hide**.
A region that only partly overlaps your list catches everyone else there too.

**Someone I follow got hidden.** Add them to *Never hide*.

**X changed something and it stopped working.** Likely; X reshuffles its site
regularly. `AGENTS.md` lists every selector and API detail the extension relies
on and how to repair them.

**Is anything sent anywhere?** No. Settings and the cache live in your
browser's extension storage. The only requests it makes are to X itself (the
About lookups) and, if X renames that lookup, one fetch of X's own script
from abs.twimg.com to find the new name.

---

## Working on it

Needs [web-ext](https://github.com/mozilla/web-ext). On NixOS:
`nix-shell -p web-ext`.

```sh
web-ext run           # Firefox with the extension loaded, reloads on change
web-ext lint --self-hosted
web-ext build         # -> web-ext-artifacts/
```

There are no automated tests; check changes in a logged-in Firefox. `AGENTS.md`
has the checklist.

To sign a new version: bump `version` in `manifest.json` and `package.json`,
put your AMO API credentials in `.env` (it's gitignored), then
`bun run sign:nix`. Set `WEB_EXT_ENV_FILE` to read the credentials from
somewhere else instead.

## License

MIT, see `LICENSE`.

## Layout

```
manifest.json
src/regions.js     country/region taxonomy and location parsing
src/settings.js    settings schema and storage
src/matcher.js     the hide / show / mark decision
src/page.js        runs X's About lookups in the page (page world)
src/content.js     finds posts, decides, hides them
src/background.js  shared cache and lookup budget
src/styles.css     how hidden, held and marked posts look
ui/                settings page and toolbar popup
```

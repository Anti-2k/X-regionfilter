# Regionfilter sync server

An optional place to keep the extension's location records, so several
browsers (yours, or a few friends') share one cache instead of each spending
its own 50-per-15-minutes lookups. The extension never connects to anything
unless you give it a server URL and a token.

It's a Cloudflare Worker with a D1 (SQLite) database, which fits in
Cloudflare's free plan. Anything that speaks the [API](#api) below works too.

Clients can only **read** records and **add newer ones**. Nothing they send
can delete or edit anything else; you manage the data by hand.

## Setup

You need a Cloudflare account and `wrangler` (`npx wrangler`, or
`nix-shell -p wrangler`). Run everything from this directory.

```sh
wrangler login
wrangler d1 create regionfilter              # prints a database_id
cp wrangler.example.toml wrangler.toml       # paste the database_id in
wrangler d1 execute regionfilter --remote --file schema.sql
wrangler deploy                              # prints https://regionfilter-sync.<you>.workers.dev
```

`wrangler.toml` is git-ignored. Keep it, tokens and anything else that lets
someone into your database out of the repository.

### Tokens

One token per person (or per machine, if you like to revoke them separately):

```sh
bun scripts/token.js laptop                  # or: node scripts/token.js laptop
bun scripts/token.js alex --read-only        # can look up, can't upload
```

It prints the token once and the `wrangler d1 execute` command that
registers it. Run that command, then put the server URL and the token in the
extension's options. Only a SHA-256 of the token is stored.

## Managing the data

All through `wrangler d1 execute regionfilter --remote --command "<SQL>"`
(or the D1 console in the Cloudflare dashboard).

| Task | SQL |
| --- | --- |
| Count records | `SELECT COUNT(*) FROM records` |
| Look at one account | `SELECT * FROM records WHERE handle = 'name'` |
| Delete one account | `DELETE FROM records WHERE handle = 'name'` |
| Clear everything | `DELETE FROM records` |
| Records by uploader | `SELECT t.name, COUNT(*) FROM records r JOIN tokens t ON t.id = r.added_by GROUP BY t.name` |
| Delete what one person uploaded | `DELETE FROM records WHERE added_by = (SELECT id FROM tokens WHERE name = 'alex')` |
| List tokens | `SELECT id, name, can_write, revoked, last_used FROM tokens` |
| Revoke a token | `UPDATE tokens SET revoked = 1 WHERE name = 'alex'` |
| Make a token read-only | `UPDATE tokens SET can_write = 0 WHERE name = 'alex'` |
| Most common locations | `SELECT based_in, COUNT(*) n FROM records GROUP BY based_in ORDER BY n DESC LIMIT 20` |

Clients keep their own local caches; clearing the server doesn't clear them,
and their next uploads will refill it with what they already know.

### Settings

How long after X gave an answer the server keeps serving it, in days
(fractional is fine, `0` stops serving that kind). An older record stays in
the table but counts as a miss, so a client looks the account up again and
uploads a fresh answer. Clients use the `exp` the server sends and don't
judge age themselves.

| Key | Default | Applies to |
| --- | --- | --- |
| `ttl_based_in_days` | 30 | X showed "Account based in" |
| `ttl_none_days` | 7 | X showed no "based in" (maybe an App Store country) |
| `ttl_missing_days` | 1 | the account doesn't exist |

```sh
wrangler d1 execute regionfilter --remote --command "UPDATE settings SET value = '60' WHERE key = 'ttl_based_in_days'"
```

Changes take effect within a minute.

## API

Every request needs `Authorization: Bearer <token>`. Bodies and responses are
JSON. Handles are matched case-insensitively and returned lowercase.

### `GET /v1/ping`

```json
{ "ok": true, "name": "laptop", "canWrite": true,
  "ttlDays": { "basedIn": 30, "none": 7, "missing": 1 } }
```

### `POST /v1/lookup`

```json
{ "handles": ["alice", "bob"] }
```

Up to 100 handles. Returns only the ones the server has a current record
for; anything absent is a miss.

```json
{ "records": {
    "alice": { "basedIn": "United States", "store": "United States App Store",
               "accurate": true, "ts": 1792226887479, "exp": 1794818887479 },
    "gone":  { "missing": true, "ts": 1792399686479, "exp": 1792486086479 } } }
```

`ts` is when X gave the answer and `exp` when the record stops being served
(both ms since epoch). `basedIn` and `store` are X's own wording, or `null`.
`accurate` is `false` when X suspects a VPN or proxy.

### `POST /v1/records`

```json
{ "records": [
    { "handle": "alice", "basedIn": "United States", "store": null,
      "accurate": true, "ts": 1792226887479 },
    { "handle": "gone", "missing": true, "ts": 1792399686479 } ] }
```

Up to 200 records. A record replaces the stored one only if its `ts` is
newer. Invalid entries (bad handle, `ts` before 2025 or in the future, text
over 100 characters) are skipped and counted.

```json
{ "stored": 1, "rejected": 0 }
```

Needs a token with `can_write`; otherwise `403`.

### Errors

`400` bad body · `401` missing, unknown or revoked token · `403` read-only
token · `404` unknown route · `500` server error. Errors look like
`{ "error": "..." }`.

## Limits

D1's free plan allows 50 queries per request, so each lookup or upload is a
single statement. A day of normal browsing is a few hundred requests, far
inside the free daily quota.

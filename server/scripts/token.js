#!/usr/bin/env bun
/* Makes an access token and prints the SQL that registers it.
 *
 *   bun scripts/token.js <name> [--read-only] [--db <database name>]
 *
 * The token is shown once and never written anywhere; the database only
 * gets its SHA-256. Paste the token into the extension's options page.
 */

const args = process.argv.slice(2);
const readOnly = args.includes('--read-only');
const dbAt = args.indexOf('--db');
const db = dbAt !== -1 ? args[dbAt + 1] : 'regionfilter';
const name = args.find((a, i) => !a.startsWith('--') && (dbAt === -1 || i !== dbAt + 1));

if (!name || !/^[A-Za-z0-9 _.-]{1,40}$/.test(name) || !/^[A-Za-z0-9_-]+$/.test(db || '')) {
  console.error('usage: bun scripts/token.js <name> [--read-only] [--db <database name>]');
  console.error('name: 1-40 letters, digits, space, _ . -');
  process.exit(1);
}

const bytes = crypto.getRandomValues(new Uint8Array(32));
const token = 'rf_' + Buffer.from(bytes).toString('base64url');
const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
const hash = Buffer.from(digest).toString('hex');

const sql = `INSERT INTO tokens (name, token_hash, can_write, created_at) ` +
            `VALUES ('${name}', '${hash}', ${readOnly ? 0 : 1}, ${Date.now()})`;

console.log(`Token for "${name}"${readOnly ? ' (read only)' : ''}, shown once:\n\n  ${token}\n`);
console.log(`Register it:\n\n  wrangler d1 execute ${db} --remote --command "${sql}"\n`);

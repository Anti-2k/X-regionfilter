-- Regionfilter sync database. Safe to run again: it never drops or resets.

-- One row per account, as X's "About this account" reported it.
CREATE TABLE IF NOT EXISTS records (
  handle      TEXT PRIMARY KEY,           -- lowercase, no @
  based_in    TEXT,                       -- "Account based in", NULL if not shown
  store       TEXT,                       -- "Connected via ... App Store", NULL if not shown
  accurate    INTEGER NOT NULL DEFAULT 1, -- 0 when X suspects a VPN or proxy
  missing     INTEGER NOT NULL DEFAULT 0, -- 1 when the account doesn't exist
  ts          INTEGER NOT NULL,           -- ms since epoch, when X gave this answer
  added_by    INTEGER,                    -- tokens.id of the uploader
  updated_at  INTEGER NOT NULL            -- ms since epoch, when the server stored it
);
CREATE INDEX IF NOT EXISTS records_added_by ON records (added_by);

-- Who may use the server. Only a SHA-256 of each token is kept.
CREATE TABLE IF NOT EXISTS tokens (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  token_hash  TEXT NOT NULL UNIQUE,
  can_write   INTEGER NOT NULL DEFAULT 1,
  revoked     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  last_used   INTEGER
);

-- How long a record is served after X gave it (days, may be fractional;
-- 0 stops serving that kind). Older records stay stored but count as a miss,
-- so a client looks the account up again and uploads a newer one.
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('ttl_based_in_days', '30'),
  ('ttl_none_days', '7'),
  ('ttl_missing_days', '1');

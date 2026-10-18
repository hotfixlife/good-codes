CREATE TABLE IF NOT EXISTS codes (
  id INTEGER PRIMARY KEY,
  domain TEXT NOT NULL,
  code TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,            -- submitted | seed | merchant
  submitted_by TEXT NOT NULL DEFAULT '',
  submitted_net TEXT NOT NULL DEFAULT '', -- hashed network of the sharer, so they can't vote it up
  created REAL NOT NULL,
  expires REAL,                    -- unix time; expired codes are hidden
  source_url TEXT NOT NULL DEFAULT '' -- where a seeded code was published (the shop's own page)
);
CREATE UNIQUE INDEX IF NOT EXISTS codes_domain_code ON codes (domain, lower(code));

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  code_id INTEGER NOT NULL REFERENCES codes(id),
  outcome TEXT NOT NULL,           -- worked | failed
  source TEXT NOT NULL,            -- auto (extension measured the total) | user (thumbs up/down)
  saving REAL,
  client_id TEXT NOT NULL,
  net TEXT NOT NULL DEFAULT '',    -- salted hash of the voter's network (IPv4 /24, IPv6 /48)
  ts REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_code_ts ON reports (code_id, ts);

-- Rate-limit hits; keys are the install id or the hashed network. Deleted after 2 days (daily cleanup).
CREATE TABLE IF NOT EXISTS hits (
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  ts REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS hits_kind_key_ts ON hits (kind, key, ts);

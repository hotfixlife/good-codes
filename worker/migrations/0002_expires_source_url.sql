-- For databases created before expires/source_url existed (run once: wrangler d1 execute fairshare --remote --file migrations/0002_expires_source_url.sql)
ALTER TABLE codes ADD COLUMN expires REAL;
ALTER TABLE codes ADD COLUMN source_url TEXT NOT NULL DEFAULT '';

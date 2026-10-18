-- Votes count once per network (run once on databases created before this).
ALTER TABLE codes ADD COLUMN submitted_net TEXT NOT NULL DEFAULT '';
ALTER TABLE reports ADD COLUMN net TEXT NOT NULL DEFAULT '';

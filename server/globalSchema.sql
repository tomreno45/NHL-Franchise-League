-- Applied directly against sessionPool (see db.js) — not one of the
-- per-league databases. Login identity used to live inside each per-league
-- database (a "users" table per league, same username independently
-- existing up to three times); it now lives here instead, so one account
-- can span multiple leagues. See accounts.js for everything that reads/
-- writes these tables, and scripts/migrateToGlobalAccounts.js for how the
-- old per-league users rows became these.

CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per (account, league) — which team (if any) and role that
-- account has in that specific league. team_id is NOT a real foreign key
-- (teams live in a different physical database per league, so a
-- cross-database FK isn't possible) — every write path validates the id
-- against that league's own teams before storing it. role mirrors the old
-- per-league users.role ('user' | 'commissioner'), app-validated the same
-- way (see accounts.js's ACCOUNT_ROLES, same pattern as every other
-- enum-shaped column in this app).
CREATE TABLE IF NOT EXISTS account_memberships (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  league_slug TEXT NOT NULL,
  team_id INTEGER,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, league_slug)
);

-- Relocated from each per-league database, where it was FK'd to that
-- league's own users.id — that broke once session identity became a
-- global accountId instead. A real FK again now that it's alongside
-- accounts. See push.js: a send is still scoped to one league (join
-- through account_memberships filtered by league_slug), matching the old
-- per-league behavior exactly, just sourced from a shared table now.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_account_memberships_account ON account_memberships(account_id);
CREATE INDEX IF NOT EXISTS idx_account_memberships_league ON account_memberships(league_slug);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_account ON push_subscriptions(account_id);

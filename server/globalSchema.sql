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

-- A global superuser flag, unrelated to the per-league 'commissioner' role
-- in account_memberships below — a commissioner's authority is scoped to
-- one league; an admin can create/edit/delete any account and its
-- memberships in any league (the in-app equivalent of the
-- scripts/*.js developer CLIs). Nothing sets this except
-- scripts/setAdmin.js — there's no in-app way to grant it, the same
-- deliberate bootstrap-only trust boundary as everything else that
-- crosses league lines.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

-- Set whenever someone else (an admin, via resetPassword) picks a new
-- password on this account's behalf — the account holder didn't choose it,
-- so the next successful login is interrupted with a forced change instead
-- of silently letting them keep using a password someone else now knows.
-- Cleared by accounts.changePassword once they've set their own.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;

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

// Global login identity — accounts and which league(s) each one belongs to.
// Deliberately separate from store.js (which is exclusively per-league game
// data, routed through db.js's AsyncLocalStorage-based `pool`) since this
// data has to exist regardless of which league is active, the same way
// push.js is its own concern-module rather than living inside store.js.
// Everything here talks to `sessionPool` directly — never the league-routed
// `pool` — because an account and its memberships aren't "in" any one
// league's database.
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const { sessionPool, LEAGUE_SLUGS } = require("./db");

function notFound(message) {
  const err = new Error(message);
  err.status = 404;
  return err;
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

const BCRYPT_ROUNDS = 10;
const ACCOUNT_ROLES = ["user", "commissioner"];

async function ensureGlobalSchema() {
  const sql = fs.readFileSync(path.join(__dirname, "globalSchema.sql"), "utf8");
  await sessionPool.query(sql);
}

// sessionPool has no AsyncLocalStorage-routed equivalent of db.js's
// withTransaction (that one is hardwired to the per-league activePool()),
// so account creation needs its own tiny local version.
async function withGlobalTransaction(fn) {
  const client = await sessionPool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function mapAccountRow(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    isAdmin: row.is_admin,
    mustChangePassword: row.must_change_password,
    createdAt: row.created_at,
  };
}

function mapMembershipRow(row) {
  return {
    leagueSlug: row.league_slug,
    teamId: row.team_id,
    role: row.role,
  };
}

async function createAccount({ username, password, displayName }) {
  if (!username || !password || !displayName) {
    throw badRequest("username, password, and displayName are all required");
  }
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  try {
    const { rows } = await sessionPool.query(
      `INSERT INTO accounts (username, password_hash, display_name) VALUES ($1, $2, $3) RETURNING *`,
      [username, passwordHash, displayName]
    );
    return mapAccountRow(rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      throw badRequest(`Username "${username}" is already taken`);
    }
    throw err;
  }
}

// Never throws on a bad username/password — "wrong password" isn't a
// server error, same convention as the old per-league verifyLogin.
async function verifyAccountLogin(username, password) {
  const { rows } = await sessionPool.query("SELECT * FROM accounts WHERE username = $1", [username]);
  if (rows.length === 0) return null;
  const row = rows[0];
  const matches = await bcrypt.compare(password, row.password_hash);
  return matches ? mapAccountRow(row) : null;
}

async function getAccountById(id) {
  const { rows } = await sessionPool.query("SELECT * FROM accounts WHERE id = $1", [id]);
  return rows.length ? mapAccountRow(rows[0]) : null;
}

// For the commissioner's "does this username already have an account
// somewhere" lookup in ManageUsers.jsx — lets them attach an existing
// account to their league instead of creating a duplicate one. This is a
// small, deliberate cross-league disclosure: a commissioner can now learn
// that a username (and its display name) exists even with no membership in
// their own league, which wasn't possible when every league's users table
// was fully isolated. Acceptable for a small invite-only friend league
// where the commissioner already knows every real person involved.
async function findAccountByUsername(username) {
  const { rows } = await sessionPool.query("SELECT * FROM accounts WHERE username = $1", [username]);
  return rows.length ? mapAccountRow(rows[0]) : null;
}

async function getMemberships(accountId) {
  const { rows } = await sessionPool.query(
    "SELECT * FROM account_memberships WHERE account_id = $1 ORDER BY league_slug",
    [accountId]
  );
  return rows.map(mapMembershipRow);
}

async function getMembership(accountId, leagueSlug) {
  const { rows } = await sessionPool.query(
    "SELECT * FROM account_memberships WHERE account_id = $1 AND league_slug = $2",
    [accountId, leagueSlug]
  );
  return rows.length ? mapMembershipRow(rows[0]) : null;
}

// Every human-controlled login for one league — replaces the old per-league
// store.getUsers(), and deliberately returns the exact same row shape
// ({id, username, displayName, teamId, role}) so UserList.jsx/ManageUsers.jsx
// need no changes beyond where the data comes from. `id` here is the
// membership row's id, not the account's — that's what "Remove" in
// ManageUsers.jsx now needs (removing a membership, not the whole account).
async function getMembersOfLeague(leagueSlug) {
  const { rows } = await sessionPool.query(
    `SELECT m.id AS membership_id, m.team_id, m.role, a.id AS account_id, a.username, a.display_name
     FROM account_memberships m
     JOIN accounts a ON a.id = m.account_id
     WHERE m.league_slug = $1
     ORDER BY a.id ASC`,
    [leagueSlug]
  );
  return rows.map((row) => ({
    id: row.membership_id,
    accountId: row.account_id,
    username: row.username,
    displayName: row.display_name,
    teamId: row.team_id,
    role: row.role,
  }));
}

async function countMembersOnTeam(leagueSlug, teamId) {
  const { rows } = await sessionPool.query(
    "SELECT COUNT(*)::int AS count FROM account_memberships WHERE league_slug = $1 AND team_id = $2",
    [leagueSlug, teamId]
  );
  return rows[0].count;
}

async function countCommissionersInLeague(leagueSlug) {
  const { rows } = await sessionPool.query(
    "SELECT COUNT(*)::int AS count FROM account_memberships WHERE league_slug = $1 AND role = 'commissioner'",
    [leagueSlug]
  );
  return rows[0].count;
}

// Adds (or, if one already exists for this account+league, replaces —
// ON CONFLICT keeps this idempotent the same way the migration script
// needs it to be) a membership. teamId is NOT validated against that
// league's real teams here — teams live in a different physical database,
// so callers (the commissioner routes) must check the id exists there
// first, the same app-level validation a real foreign key used to give for
// free on the old per-league users.team_id.
async function addMembership({ accountId, leagueSlug, teamId = null, role = "user" }) {
  if (!LEAGUE_SLUGS.includes(leagueSlug)) {
    throw badRequest(`Unknown league "${leagueSlug}"`);
  }
  if (!ACCOUNT_ROLES.includes(role)) {
    throw badRequest(`role must be one of ${ACCOUNT_ROLES.join(", ")}`);
  }
  const { rows } = await sessionPool.query(
    `INSERT INTO account_memberships (account_id, league_slug, team_id, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (account_id, league_slug) DO UPDATE SET team_id = EXCLUDED.team_id, role = EXCLUDED.role
     RETURNING *`,
    [accountId, leagueSlug, teamId, role]
  );
  return mapMembershipRow(rows[0]);
}

// Takes the membership row's own id (what ManageUsers.jsx's list actually
// has, via getMembersOfLeague) rather than an (accountId, leagueSlug) pair
// — expectedLeagueSlug is the requesting commissioner's own current
// league, checked against the row's actual league so a membership id can
// never be used to reach into a league the caller isn't commissioner of.
// Mirrors the old deleteUser's two guards, both re-scoped to this one
// league (not global) — someone can legitimately be the sole commissioner
// in Production while holding no role at all in Test; removing them from
// Test shouldn't be blocked by that.
async function removeMembership({ membershipId, expectedLeagueSlug, requestingAccountId }) {
  const { rows } = await sessionPool.query("SELECT * FROM account_memberships WHERE id = $1", [membershipId]);
  if (rows.length === 0) {
    throw notFound("Membership not found");
  }
  const membership = rows[0];
  if (membership.league_slug !== expectedLeagueSlug) {
    throw notFound("Membership not found");
  }
  if (membership.account_id === requestingAccountId) {
    throw badRequest("You can't remove yourself from the league you're currently signed into");
  }
  if (membership.role === "commissioner") {
    const count = await countCommissionersInLeague(expectedLeagueSlug);
    if (count <= 1) {
      throw badRequest("Can't remove the only commissioner in this league — make another account commissioner first");
    }
  }
  await sessionPool.query("DELETE FROM account_memberships WHERE id = $1", [membershipId]);
  return { removed: true, accountId: membership.account_id, leagueSlug: expectedLeagueSlug, teamId: membership.team_id };
}

// Every account, everywhere, with its full membership list attached —
// backs the Admin Panel's account list, which (unlike ManageUsers.jsx) is
// deliberately not scoped to one league.
async function getAllAccountsWithMemberships() {
  const [accountsResult, membershipsResult] = await Promise.all([
    sessionPool.query("SELECT * FROM accounts ORDER BY id"),
    sessionPool.query("SELECT * FROM account_memberships ORDER BY league_slug"),
  ]);
  const membershipsByAccount = new Map();
  for (const row of membershipsResult.rows) {
    const list = membershipsByAccount.get(row.account_id) || [];
    // Includes the membership row's own id (unlike mapMembershipRow's usual
    // shape) — the Admin Panel's "Remove" action needs it for
    // removeMembershipByIdAsAdmin, the same way getMembersOfLeague already
    // does for the per-league commissioner view.
    list.push({ id: row.id, ...mapMembershipRow(row) });
    membershipsByAccount.set(row.account_id, list);
  }
  return accountsResult.rows.map((row) => ({
    ...mapAccountRow(row),
    memberships: membershipsByAccount.get(row.id) || [],
  }));
}

// scripts/setAdmin.js only — no route calls this, granting admin is
// bootstrap-only (see the is_admin column's comment in globalSchema.sql).
async function setAdminFlag(accountId, isAdmin) {
  const { rows } = await sessionPool.query("UPDATE accounts SET is_admin = $1 WHERE id = $2 RETURNING *", [
    isAdmin,
    accountId,
  ]);
  if (rows.length === 0) {
    throw notFound("Account not found");
  }
  return mapAccountRow(rows[0]);
}

// The admin-only equivalent of removeMembership — takes just the
// membership id, no league-match or self-removal check (an admin's
// authority isn't scoped to one league the way a commissioner's is, and
// removing their own membership to some other league doesn't strand
// anything the way removing a commissioner's own active league would). The
// last-commissioner guard still applies — that's a safety rail worth
// keeping regardless of who's making the change.
async function removeMembershipByIdAsAdmin(membershipId) {
  const { rows } = await sessionPool.query("SELECT * FROM account_memberships WHERE id = $1", [membershipId]);
  if (rows.length === 0) {
    throw notFound("Membership not found");
  }
  const membership = rows[0];
  if (membership.role === "commissioner") {
    const count = await countCommissionersInLeague(membership.league_slug);
    if (count <= 1) {
      throw badRequest("Can't remove the only commissioner in this league — make another account commissioner first");
    }
  }
  await sessionPool.query("DELETE FROM account_memberships WHERE id = $1", [membershipId]);
  return { removed: true, accountId: membership.account_id, leagueSlug: membership.league_slug, teamId: membership.team_id };
}

// Sets a brand new password directly — for a developer running
// scripts/resetPassword.js when someone forgets theirs. No "old password"
// check (that's the whole point: they've forgotten it), so this only ever
// runs from a trusted, out-of-band channel (shell access to the server),
// never exposed over HTTP to commissioners — a commissioner in one league
// shouldn't be able to reset the password on an account that might belong
// to leagues they have no authority over.
async function resetPassword(accountId, newPassword) {
  if (!newPassword) {
    throw badRequest("newPassword is required");
  }
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  const { rows } = await sessionPool.query(
    "UPDATE accounts SET password_hash = $1, must_change_password = true WHERE id = $2 RETURNING *",
    [passwordHash, accountId]
  );
  if (rows.length === 0) {
    throw notFound("Account not found");
  }
  return mapAccountRow(rows[0]);
}

// The account holder picking their own new password, in response to
// mustChangePassword — see server.js's POST /api/auth/change-password,
// reachable only once accountId is already in session (i.e. credentials,
// old or temporary, were already verified by login). No old-password check
// needed for the same reason: getting here already proved they hold the
// current one. Clears the flag, unlike resetPassword which sets it.
async function changePassword(accountId, newPassword) {
  if (!newPassword) {
    throw badRequest("newPassword is required");
  }
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  const { rows } = await sessionPool.query(
    "UPDATE accounts SET password_hash = $1, must_change_password = false WHERE id = $2 RETURNING *",
    [passwordHash, accountId]
  );
  if (rows.length === 0) {
    throw notFound("Account not found");
  }
  return mapAccountRow(rows[0]);
}

// Wipes the account entirely — every membership in every league goes with
// it (ON DELETE CASCADE), same for any push subscriptions. Irreversible:
// the username becomes available again and nothing is left to "add back"
// the way a plain removeMembership leaves the account intact for later.
// Same trust boundary as resetPassword — developer/shell-access only, never
// an HTTP route, since a single commissioner's league-scoped authority
// shouldn't extend to erasing someone's access everywhere at once.
async function deleteAccountEntirely(accountId) {
  const { rows } = await sessionPool.query("DELETE FROM accounts WHERE id = $1 RETURNING *", [accountId]);
  if (rows.length === 0) {
    throw notFound("Account not found");
  }
  return mapAccountRow(rows[0]);
}

module.exports = {
  ensureGlobalSchema,
  withGlobalTransaction,
  createAccount,
  verifyAccountLogin,
  getAccountById,
  findAccountByUsername,
  getMemberships,
  getMembership,
  getMembersOfLeague,
  getAllAccountsWithMemberships,
  countMembersOnTeam,
  addMembership,
  removeMembership,
  removeMembershipByIdAsAdmin,
  resetPassword,
  changePassword,
  deleteAccountEntirely,
  setAdminFlag,
};

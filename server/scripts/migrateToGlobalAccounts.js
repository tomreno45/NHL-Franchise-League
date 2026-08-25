// One-off migration: moves login accounts out of each per-league `users`
// table and into the new shared accounts/account_memberships tables (see
// accounts.js), merging any username that appears in more than one league
// today into a single global account with a membership per league it was
// found in (per the confirmed decision — see the plan this shipped with).
// Also carries push_subscriptions rows forward through the same mapping.
//
// Two-pass by design — review before you commit:
//   node scripts/migrateToGlobalAccounts.js --dry-run    (prints the report, writes nothing)
//   node scripts/migrateToGlobalAccounts.js --commit     (applies it)
//
// Idempotent either way (upserts on username / (account_id, league_slug) /
// endpoint), so re-running --commit after fixing something in MANUAL_SPLITS
// below is safe. Rehearse against Test and Development (free, identical
// logic) before touching Production. Does not touch or drop the old
// per-league `users`/`push_subscriptions` tables — left inert, matching
// this codebase's convention of never dropping superseded tables.
//
// If review of the --dry-run report reveals a username that is NOT
// actually the same person across leagues (rare, but the merge-by-username
// default can't know that), list it here before running --commit so that
// league keeps its own separate account instead of being merged in:
//   MANUAL_SPLITS = { "someusername": ["test"] }   // "test" gets its own account
const MANUAL_SPLITS = {};

const { pool, sessionPool, runWithLeague, LEAGUE_SLUGS } = require("../db");
const accounts = require("../accounts");

const commit = process.argv.includes("--commit");
const dryRun = process.argv.includes("--dry-run");
if (!commit && !dryRun) {
  console.error("Usage: node scripts/migrateToGlobalAccounts.js --dry-run | --commit");
  process.exitCode = 1;
  return;
}

// Most-authoritative-first — used only to pick whose password_hash/
// display_name "wins" when the same username has different values in more
// than one league today.
const LEAGUE_PRIORITY = ["production", "development", "test"];

async function collectPerLeagueUsers() {
  const byLeague = {};
  for (const slug of LEAGUE_SLUGS) {
    byLeague[slug] = await runWithLeague(slug, async () => {
      const { rows } = await pool.query("SELECT * FROM users ORDER BY id");
      return rows;
    });
  }
  return byLeague;
}

async function collectPerLeaguePushSubscriptions() {
  const byLeague = {};
  for (const slug of LEAGUE_SLUGS) {
    byLeague[slug] = await runWithLeague(slug, async () => {
      try {
        const { rows } = await pool.query("SELECT * FROM push_subscriptions");
        return rows;
      } catch (err) {
        // Table doesn't exist in this league's DB — nothing to carry over.
        if (err.code === "42P01") return [];
        throw err;
      }
    });
  }
  return byLeague;
}

// One entry per (username, league) that should become its own account —
// i.e. the normal merge-by-username groups, split apart wherever
// MANUAL_SPLITS says a username isn't actually the same person everywhere.
function groupByAccount(usersByLeague) {
  const groups = new Map(); // key -> { key, rows: [{league, row}] }
  for (const league of LEAGUE_SLUGS) {
    for (const row of usersByLeague[league]) {
      const splitLeagues = MANUAL_SPLITS[row.username];
      const key = splitLeagues && splitLeagues.includes(league) ? `${row.username}::${league}` : row.username;
      if (!groups.has(key)) groups.set(key, { key, rows: [] });
      groups.get(key).rows.push({ league, row });
    }
  }
  return [...groups.values()];
}

function pickCanonical(rows) {
  for (const league of LEAGUE_PRIORITY) {
    const found = rows.find((r) => r.league === league);
    if (found) return found;
  }
  return rows[0];
}

async function upsertAccount(client, { username, passwordHash, displayName }) {
  const existing = await client.query("SELECT * FROM accounts WHERE username = $1", [username]);
  if (existing.rows.length > 0) return existing.rows[0];
  const inserted = await client.query(
    `INSERT INTO accounts (username, password_hash, display_name) VALUES ($1, $2, $3) RETURNING *`,
    [username, passwordHash, displayName]
  );
  return inserted.rows[0];
}

async function upsertMembership(client, { accountId, leagueSlug, teamId, role }) {
  await client.query(
    `INSERT INTO account_memberships (account_id, league_slug, team_id, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (account_id, league_slug) DO UPDATE SET team_id = EXCLUDED.team_id, role = EXCLUDED.role`,
    [accountId, leagueSlug, teamId, role]
  );
}

async function upsertPushSubscription(client, { accountId, endpoint, p256dh, auth }) {
  await client.query(
    `INSERT INTO push_subscriptions (account_id, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET account_id = EXCLUDED.account_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [accountId, endpoint, p256dh, auth]
  );
}

async function main() {
  await accounts.ensureGlobalSchema();

  const usersByLeague = await collectPerLeagueUsers();
  const pushByLeague = await collectPerLeaguePushSubscriptions();
  const groups = groupByAccount(usersByLeague);

  console.log(`\nFound ${groups.length} account(s) across ${LEAGUE_SLUGS.join(", ")}:\n`);

  // oldUserId, keyed by `${league}:${oldId}`, -> the account id it should
  // resolve to, for the push_subscriptions carry-over pass below.
  const oldIdToAccountId = {};

  for (const group of groups) {
    const canonical = pickCanonical(group.rows);
    const displayNames = new Set(group.rows.map((r) => r.row.display_name));
    const leagueList = group.rows.map((r) => `${r.league} (${r.row.display_name}, role: ${r.row.role})`).join(", ");
    console.log(`- "${canonical.row.username}" -> ${leagueList}`);
    if (displayNames.size > 1) {
      console.log(
        `  ⚠ display name differs across leagues for this username — double check this is really the same person before committing (or add it to MANUAL_SPLITS to keep them separate).`
      );
    }
    console.log(`  password: carried over from ${canonical.league} (bcrypt hash copied as-is, no reset needed)`);

    if (commit) {
      const client = await sessionPool.connect();
      try {
        await client.query("BEGIN");
        const account = await upsertAccount(client, {
          username: canonical.row.username,
          passwordHash: canonical.row.password_hash,
          displayName: canonical.row.display_name,
        });
        for (const { league, row } of group.rows) {
          await upsertMembership(client, {
            accountId: account.id,
            leagueSlug: league,
            teamId: row.team_id,
            role: row.role,
          });
          oldIdToAccountId[`${league}:${row.id}`] = account.id;
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }
  }

  let carriedSubs = 0;
  if (commit) {
    const client = await sessionPool.connect();
    try {
      await client.query("BEGIN");
      for (const league of LEAGUE_SLUGS) {
        for (const sub of pushByLeague[league]) {
          const accountId = oldIdToAccountId[`${league}:${sub.user_id}`];
          if (!accountId) continue; // orphaned subscription row, nothing to attach it to
          await upsertPushSubscription(client, {
            accountId,
            endpoint: sub.endpoint,
            p256dh: sub.p256dh,
            auth: sub.auth,
          });
          carriedSubs++;
        }
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } else {
    carriedSubs = LEAGUE_SLUGS.reduce((sum, league) => sum + pushByLeague[league].length, 0);
  }

  console.log(
    `\n${commit ? "Carried over" : "Would carry over"} ${carriedSubs} push subscription(s).`
  );
  console.log(
    commit
      ? "\nDone — accounts and memberships created. Old per-league users/push_subscriptions tables left untouched."
      : "\nDry run only — nothing was written. Re-run with --commit to apply."
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

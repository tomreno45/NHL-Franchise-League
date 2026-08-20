require("dotenv").config();
const { Pool, types } = require("pg");
const { AsyncLocalStorage } = require("async_hooks");

// DATE columns (OID 1082) default to JS Date objects, which pg parses at UTC
// midnight and can shift a day off when re-serialized in a local timezone.
// The app treats dates as plain 'YYYY-MM-DD' strings everywhere, so keep them
// as-is instead of letting pg round-trip them through Date.
types.setTypeParser(1082, (val) => val);

// Multiple parallel "leagues" (Test / Development / Production), each a
// fully separate Postgres database with an identical schema rather than a
// shared database with a league_id column threaded through every table and
// every query. That tradeoff was deliberate: switching leagues then can't
// leak data across leagues via one missed WHERE clause, and every existing
// store.js query (already ~150 of them) needed zero changes — they all just
// keep calling `pool.query(...)`, which now transparently resolves to
// whichever league's real Pool is active for the current request (see
// runWithLeague/activePool below). New leagues are a deploy-time config
// decision, not something the app mutates itself, so this lives here as a
// constant rather than a table.
const LEAGUES = {
  test: { label: "Test", connectionString: process.env.DATABASE_URL_TEST },
  development: { label: "Development", connectionString: process.env.DATABASE_URL_DEVELOPMENT },
  production: { label: "Production", connectionString: process.env.DATABASE_URL_PRODUCTION },
};
const LEAGUE_SLUGS = Object.keys(LEAGUES);

const leagueContext = new AsyncLocalStorage();
const leaguePools = {};

function poolFor(slug) {
  const league = LEAGUES[slug];
  if (!league) throw new Error(`Unknown league "${slug}"`);
  if (!leaguePools[slug]) {
    leaguePools[slug] = new Pool({ connectionString: league.connectionString });
  }
  return leaguePools[slug];
}

// Establishes `slug` as the active league for `fn` and for every store.js
// call made — directly or via any awaited async work — during its
// execution. server.js's per-request middleware is the only normal caller;
// scripts run standalone (see the LEAGUE env var fallback in activePool
// below) instead of calling this directly.
function runWithLeague(slug, fn) {
  return leagueContext.run(slug, fn);
}

// Falls back to the LEAGUE env var (never to a hardcoded default league)
// so a one-off script forgetting to set it fails loudly instead of quietly
// running against the wrong database — that matters most for the
// destructive scripts (importRealRosters.js and friends).
function activePool() {
  const slug = leagueContext.getStore() || process.env.LEAGUE;
  if (!slug) {
    throw new Error(
      "No league selected. The server sets this per-request from the session; " +
        "standalone scripts must set LEAGUE=test|development|production, e.g. `LEAGUE=test node scripts/foo.js`."
    );
  }
  return poolFor(slug);
}

// store.js's existing `const { pool } = require("./db")` calls stay exactly
// as they are — `pool.query(...)` / `pool.connect(...)` now just resolve to
// whichever league is active.
const pool = {
  query: (...args) => activePool().query(...args),
  connect: (...args) => activePool().connect(...args),
};

function query(text, params) {
  return activePool().query(text, params);
}

async function withTransaction(fn) {
  const client = await activePool().connect();
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

// A separate, always-on pool for express-session (connect-pg-simple). The
// session has to exist before a league is even chosen — the login form's
// league picker is literally what gets written into it — so it can't live
// inside one of the per-league databases above. Points at the original
// hockey_franchise database, which this app used single-tenant before the
// Test/Development/Production split; its old teams/players/etc. tables are
// just unused now, left in place rather than dropped.
const sessionPool = new Pool({ connectionString: process.env.DATABASE_URL });

module.exports = { pool, query, withTransaction, runWithLeague, LEAGUE_SLUGS, LEAGUES, sessionPool };

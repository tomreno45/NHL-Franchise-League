const fs = require("fs");
const path = require("path");
const { pool, withTransaction } = require("./db");
const { teams, players, schedule, TODAY } = require("./data");

async function ensureSchema() {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(sql);
}

// Only seeds when the database is empty, so restarts never overwrite whatever
// scores, progression, or generated seasons have accumulated since.
async function seedIfEmpty() {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM teams");
  if (rows[0].count > 0) {
    return false;
  }

  const nextGameId = schedule.reduce((max, g) => Math.max(max, g.id), 0) + 1;

  await withTransaction(async (client) => {
    for (const t of teams) {
      await client.query(
        `INSERT INTO teams (id, city, name, abbr, conference, division, is_human_controlled)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [t.id, t.city, t.name, t.abbr, t.conference, t.division, t.isHumanControlled]
      );
    }

    for (const p of players) {
      await client.query(
        `INSERT INTO players
           (id, team_id, name, position, jersey_number, age, overall, cap_hit,
            contract_years_left, in_game_status, attributes, potential, stats)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          p.id,
          p.teamId,
          p.name,
          p.position,
          p.jerseyNumber,
          p.age,
          p.overall,
          p.capHit,
          p.contractYearsLeft,
          p.inGameStatus,
          JSON.stringify(p.attributes),
          JSON.stringify(p.potential),
          JSON.stringify(p.stats),
        ]
      );
    }

    for (const g of schedule) {
      await client.query(
        `INSERT INTO games (id, date, home_team_id, away_team_id, status, home_score, away_score, went_to_ot, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [g.id, g.date, g.homeTeamId, g.awayTeamId, g.status, g.homeScore, g.awayScore, g.wentToOT, g.source]
      );
    }

    await client.query(
      `INSERT INTO league_state (id, season_number, league_date, next_game_id) VALUES (1, 1, $1, $2)`,
      [TODAY, nextGameId]
    );
  });

  return true;
}

// Backfills draft picks for the current season through DRAFT_TRADE_WINDOW
// years out if any of them are missing — covers a fresh seed (season 1, no
// picks), an existing database from before draft picks existed, and an
// existing database from before the multi-year trading window existed.
// Idempotent: safe to call on every startup, and never touches a season
// that already has picks.
async function ensureDraftPicks() {
  const stateRes = await pool.query("SELECT season_number FROM league_state WHERE id = 1");
  if (stateRes.rows.length === 0) return;
  const seasonNumber = stateRes.rows[0].season_number;

  const store = require("./store");
  await store.ensureDraftPicksThroughWindow(seasonNumber);
}

// Same idempotent backfill pattern as ensureDraftPicks, for the same two
// cases: a fresh seed (season 1, no prospects yet) and an existing database
// from before draft prospects existed.
async function ensureDraftClass() {
  const stateRes = await pool.query("SELECT season_number FROM league_state WHERE id = 1");
  if (stateRes.rows.length === 0) return;
  const seasonNumber = stateRes.rows[0].season_number;

  const countRes = await pool.query(
    "SELECT COUNT(*)::int AS count FROM draft_prospects WHERE season_number = $1",
    [seasonNumber]
  );
  if (countRes.rows[0].count === 0) {
    const store = require("./store");
    await store.generateRandomDraftClass(seasonNumber);
  }
}

// Gives every team a real dressed lineup on day one of a brand new league,
// instead of 35 players sitting in MINORS with an empty line editor — only
// runs the one time seedIfEmpty() actually seeded a fresh database, never on
// a normal restart of an existing one.
async function ensureInitialLineups() {
  const store = require("./store");
  for (const t of teams) {
    await store.autoSetLineup(t.id);
  }
}

async function initDatabase() {
  await ensureSchema();
  const seeded = await seedIfEmpty();
  if (seeded) {
    await ensureInitialLineups();
  }
  await ensureDraftPicks();
  await ensureDraftClass();
  return seeded;
}

module.exports = { initDatabase };

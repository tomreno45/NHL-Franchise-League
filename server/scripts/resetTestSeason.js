// One-off maintenance: resets the Test league back to the beginning of
// season 1 using the new NHL-style schedule (84 games/team, human-vs-human
// rivalry elevated to 3 meetings — see scheduleGenerator.js's
// generateNhlStyleSchedule). Replaces the old 62-game round-robin schedule
// entirely. Not part of the normal app; run once by hand and safe to delete
// afterward (kept only as a record of how this was done, same convention as
// importRealRosters.js).
process.env.LEAGUE = "test"; // must be set before requiring db.js — see db.js's activePool()

const { pool, withTransaction } = require("../db");
const store = require("../store");
const { generateNhlStyleSchedule } = require("../scheduleGenerator");

const EMPTY_SKATER_STATS = { gamesPlayed: 0, goals: 0, assists: 0, points: 0, plusMinus: 0 };
const EMPTY_GOALIE_STATS = {
  gamesPlayed: 0,
  wins: 0,
  losses: 0,
  otLosses: 0,
  goalsAgainstAverage: 0,
  savePercentage: 0,
  shutouts: 0,
  _goalsAgainstTotal: 0,
  _shotsFacedTotal: 0,
};

async function main() {
  // --- 1. Reset every player's season stats + in-game status + lineup slot ---
  await pool.query(
    `UPDATE players SET stats = $1, in_game_status = 'not_created', roster_assignment = 'MINORS' WHERE position <> 'G'`,
    [JSON.stringify(EMPTY_SKATER_STATS)]
  );
  await pool.query(
    `UPDATE players SET stats = $1, in_game_status = 'not_created', roster_assignment = 'MINORS' WHERE position = 'G'`,
    [JSON.stringify(EMPTY_GOALIE_STATS)]
  );
  console.log("Reset all player season stats to zero, in_game_status to not_created, roster_assignment to MINORS.");

  // --- 2. Rebuild a sane starting lineup for every team ---
  const { rows: teams } = await pool.query(
    "SELECT id, is_human_controlled AS \"isHumanControlled\" FROM teams ORDER BY id"
  );
  for (const t of teams) {
    await store.autoSetLineup(t.id);
  }
  console.log(`Auto-set lineups for all ${teams.length} teams.`);

  // --- 3. Rebuild the schedule with the new 84-game NHL-style generator ---
  const seasonStartDate = "2026-10-01";
  const generated = generateNhlStyleSchedule(teams, { startDate: seasonStartDate, daysBetweenRounds: 3 });
  await withTransaction(async (client) => {
    await client.query("DELETE FROM games");
    let nextId = 1;
    for (const g of generated) {
      await client.query(
        `INSERT INTO games (id, date, home_team_id, away_team_id, status, home_score, away_score, went_to_ot, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [nextId, g.date, g.homeTeamId, g.awayTeamId, g.status, g.homeScore, g.awayScore, g.wentToOT, g.source]
      );
      nextId++;
    }
    await client.query(
      "UPDATE league_state SET league_date = $1, next_game_id = $2, phase = 'regular_season', phase_round = 1, current_pick_index = 0 WHERE id = 1",
      [seasonStartDate, nextId]
    );
  });
  console.log(`Generated ${generated.length}-game schedule (84 games/team) starting ${seasonStartDate}.`);

  // --- 4. Clear stale in-progress transaction/administrative data ---
  await pool.query("DELETE FROM free_agent_bids");
  await pool.query("DELETE FROM trade_proposals");
  await pool.query("DELETE FROM cpu_trade_offers");
  await pool.query("DELETE FROM cpu_trade_offer_batches");
  await pool.query("DELETE FROM notifications");
  await pool.query("DELETE FROM draft_order");
  await pool.query("DELETE FROM season_results");
  await pool.query("DELETE FROM progression_runs");
  console.log(
    "Cleared free_agent_bids, trade_proposals, cpu_trade_offers, cpu_trade_offer_batches, notifications, draft_order, season_results, progression_runs."
  );

  console.log("\nDone — Test league reset to the beginning of season 1 with the new 84-game schedule.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

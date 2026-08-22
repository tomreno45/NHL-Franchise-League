// One-off maintenance: resets a league back to the beginning of season 1
// using the new NHL-style schedule (84 games/team, every human-vs-human
// pair elevated to 3 meetings — see scheduleGenerator.js's
// generateNhlStyleSchedule). Replaces whatever schedule the league had
// entirely. Generalized from resetTestSeason.js (which did the same thing
// hardcoded to Test) so Development and Production could get the same
// treatment without copy-pasting it a second time. Not part of the normal
// app; run once by hand per league and safe to delete afterward.
//
// Usage: LEAGUE=test|development|production node scripts/resetSeasonToDay1.js
if (!["test", "development", "production"].includes(process.env.LEAGUE)) {
  console.error("Usage: LEAGUE=test|development|production node scripts/resetSeasonToDay1.js");
  process.exit(1);
}

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
  const league = process.env.LEAGUE;

  // --- 1. Reset every player's season stats + lineup slot ---
  //
  // in_game_status deliberately untouched here — it tracks whether a
  // player's DB record matches what actually exists in NHL 27, which has
  // nothing to do with a season/stats reset. Every player currently on a
  // roster was already created in-game before this reset runs, so forcing
  // them all back to 'not_created' (the old behavior) was just wrong —
  // it made the Progression/Commissioner "needs sync" views claim a full
  // league's worth of players needed creating when none of them did.
  await pool.query(`UPDATE players SET stats = $1, roster_assignment = 'MINORS' WHERE position <> 'G'`, [
    JSON.stringify(EMPTY_SKATER_STATS),
  ]);
  await pool.query(`UPDATE players SET stats = $1, roster_assignment = 'MINORS' WHERE position = 'G'`, [
    JSON.stringify(EMPTY_GOALIE_STATS),
  ]);
  console.log(`[${league}] Reset all player season stats to zero, roster_assignment to MINORS.`);

  // --- 2. Rebuild a sane starting lineup for every team ---
  const { rows: teams } = await pool.query(
    "SELECT id, is_human_controlled AS \"isHumanControlled\" FROM teams ORDER BY id"
  );
  for (const t of teams) {
    await store.autoSetLineup(t.id);
  }
  console.log(`[${league}] Auto-set lineups for all ${teams.length} teams.`);

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
  console.log(`[${league}] Generated ${generated.length}-game schedule (84 games/team) starting ${seasonStartDate}.`);

  // --- 4. Clear stale in-progress transaction/administrative data ---
  await pool.query("DELETE FROM free_agent_bids");
  await pool.query("DELETE FROM trade_proposals");
  await pool.query("DELETE FROM cpu_trade_offers");
  await pool.query("DELETE FROM cpu_trade_offer_batches");
  await pool.query("DELETE FROM notifications");
  await pool.query("DELETE FROM draft_order");
  await pool.query("DELETE FROM season_results");
  await pool.query("DELETE FROM phase_ready_teams");
  // Every player's overall/attributes/age get reset by whatever re-import
  // put them back to their day-1 values (this script itself doesn't touch
  // overall/age/attributes, but is always run alongside one), so a leftover
  // progression_runs row from before the reset would show change deltas
  // against numbers that no longer exist — e.g. "88 -> 81" for a player
  // who's back at 88 with no progression run against the reset roster yet.
  await pool.query("DELETE FROM progression_runs");
  console.log(
    `[${league}] Cleared free_agent_bids, trade_proposals, cpu_trade_offers, cpu_trade_offer_batches, notifications, draft_order, season_results, phase_ready_teams, progression_runs.`
  );

  console.log(`\n[${league}] Done — reset to the beginning of season 1 with the new 84-game schedule.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

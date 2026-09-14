// One-time backfill for the new nhl27_team_id column (see schema.sql) —
// assumes every player already in the database is already correctly
// rostered in NHL 27 as of right now, so this sets their "last confirmed
// NHL 27 team" to match their current team_id. Only touches rows that are
// still NULL (a fresh draft pick legitimately starts there and should stay
// there, not get silently marked synced).
//
// Only correct for a league with NO trade/signing history yet — for one
// that already has real transactions, this would wrongly mark players
// who've already moved as "already synced" on their NEW team, when NHL 27
// still has them on their OLD one. Use
// backfillNhl27TeamIdFromHistory.js instead for those; it's safe to run
// unconditionally either way since it reconstructs from actual recorded
// transactions rather than assuming everyone is already synced.
//
// Deliberately NOT part of schema.sql's auto-run migrations: rerunning this
// after real trades/signings have happened would erase genuine pending
// moves the commissioner's Roster Moves tab is supposed to be tracking.
// Run once per league right after this ships: LEAGUE=test|development|
// production|og_hfl node scripts/backfillNhl27TeamId.js
const { pool } = require("../db");

async function main() {
  if (!process.env.LEAGUE) {
    throw new Error("Set LEAGUE=test|development|production|og_hfl");
  }
  const { rowCount } = await pool.query(
    "UPDATE players SET nhl27_team_id = team_id WHERE nhl27_team_id IS NULL AND team_id IS NOT NULL"
  );
  console.log(`[${process.env.LEAGUE}] backfilled nhl27_team_id for ${rowCount} player(s)`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

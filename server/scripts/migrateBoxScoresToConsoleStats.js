// One-time migration for games scored BEFORE console games became "final
// score only" (see store.js's submitScore): each of those stored a full
// per-player box score in games.box_score, and its stat contributions were
// credited straight into players.stats. The commissioner's User Game Stats
// tab now owns user-game stats as running totals in players.console_stats, so
// this adds each old box score's contributions into console_stats — WITHOUT
// touching players.stats, which already includes them — so the tab starts out
// showing them, and re-entering a total replaces them instead of stacking on
// top (which would double-count).
//
// Run once per league right after deploying that change, before anyone uses
// the tab: LEAGUE=og_hfl node scripts/migrateBoxScoresToConsoleStats.js
// Skips any player who already has console_stats (so it can't overwrite
// numbers entered in the tab), and does nothing if no game has a box score.
const { pool } = require("../db");

function emptySkater() {
  return { gamesPlayed: 0, goals: 0, assists: 0 };
}
function emptyGoalie() {
  return { gamesPlayed: 0, wins: 0, losses: 0, otLosses: 0, shutouts: 0, goalsAgainst: 0, shotsFaced: 0 };
}

async function main() {
  if (!process.env.LEAGUE) throw new Error("Set LEAGUE=test|development|production|og_hfl");

  const { rows: games } = await pool.query("SELECT id, box_score FROM games WHERE box_score IS NOT NULL ORDER BY id");
  if (games.length === 0) {
    console.log(`[${process.env.LEAGUE}] no games with a stored box score — nothing to migrate.`);
    return;
  }

  const totals = new Map(); // playerId -> { kind: "skater" | "goalie", stats }
  const skater = (id) => {
    if (!totals.has(id)) totals.set(id, { kind: "skater", stats: emptySkater() });
    return totals.get(id).stats;
  };
  const goalie = (id) => {
    if (!totals.has(id)) totals.set(id, { kind: "goalie", stats: emptyGoalie() });
    return totals.get(id).stats;
  };

  for (const { box_score: box } of games) {
    const goalsOf = (side) => side.skaters.reduce((sum, s) => sum + s.goals, 0);
    const sides = [
      { side: box.home, opponentGoals: goalsOf(box.away) },
      { side: box.away, opponentGoals: goalsOf(box.home) },
    ];
    for (const { side, opponentGoals } of sides) {
      for (const s of side.skaters) {
        const t = skater(s.playerId);
        t.gamesPlayed += 1;
        t.goals += s.goals;
        t.assists += s.assists;
      }
      const g = goalie(side.goalieId);
      const goalsFor = goalsOf(side);
      g.gamesPlayed += 1;
      if (goalsFor > opponentGoals) g.wins += 1;
      else if (box.wentToOT) g.otLosses += 1;
      else g.losses += 1;
      if (opponentGoals === 0) g.shutouts += 1;
      g.goalsAgainst += opponentGoals;
      g.shotsFaced += side.shotsFaced;
    }
  }

  let migrated = 0;
  let skipped = 0;
  for (const [playerId, { stats }] of totals) {
    const { rowCount } = await pool.query(
      "UPDATE players SET console_stats = $1 WHERE id = $2 AND console_stats IS NULL",
      [JSON.stringify(stats), playerId]
    );
    if (rowCount > 0) migrated++;
    else skipped++;
  }
  console.log(
    `[${process.env.LEAGUE}] ${games.length} box-score game(s): set console_stats for ${migrated} player(s), skipped ${skipped} that already had entered totals or no longer exist.`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });

// One-time correction: the real-roster import (importRealRosters.js) priced
// every player at their individual "market rate" via computeContractDemand,
// which is realistic per-player but never accounted for the team-wide
// salary cap — the sum of 20-25 market-rate players comfortably exceeds a
// real NHL cap. This scales every team's cap hits down so the team actually
// fits under the season 1 (2026-27) ceiling, the same way a real front
// office's actual mix of team-friendly/overpaid deals nets out under the
// cap even though no individual contract is "capped."
//
// Only the active roster (non-MINORS) counts against the cap — same rule
// store.js's capContribution() enforces going forward — so that's what's
// scaled against the ceiling. Every player's cap_hit is scaled by the same
// per-team factor (including MINORS players, so a future call-up still
// looks like a normal contract, not an untouched pre-rescale number), with
// a floor at the league minimum ($0.925M) and a second corrective pass so
// hitting that floor doesn't push the team back over target.
const { pool } = require("../db");
const store = require("../store");

const LEAGUE_MINIMUM = 0.925;
// Land a little under the ceiling, not exactly on it — real teams vary in
// how close to the cap they sit, and starting every team at literally
// $0 of space would make the very next transaction impossible league-wide.
const TARGET_FACTOR = 0.99;

function round025(value) {
  return Math.round(value * 40) / 40;
}

// Scales `values` (active-roster cap hits) down to sum to `target`,
// respecting LEAGUE_MINIMUM as a floor — a naive uniform scale can push
// cheap players below the floor, so anything clamped up there has its
// share of the reduction redistributed across the players still above it.
function scaleToTarget(values, target) {
  let factor = target / values.reduce((sum, v) => sum + v, 0);
  let result = values.map((v) => Math.max(LEAGUE_MINIMUM, v * factor));

  for (let pass = 0; pass < 5; pass++) {
    const total = result.reduce((sum, v) => sum + v, 0);
    const deficit = total - target;
    if (Math.abs(deficit) < 0.001) break;

    const aboveFloorIdx = result.map((v, i) => i).filter((i) => result[i] > LEAGUE_MINIMUM + 0.0001);
    const aboveFloorTotal = aboveFloorIdx.reduce((sum, i) => sum + (result[i] - LEAGUE_MINIMUM), 0);
    if (aboveFloorTotal <= 0) break; // everyone's at the floor — can't reduce further

    const correction = (aboveFloorTotal - deficit) / aboveFloorTotal;
    aboveFloorIdx.forEach((i) => {
      result[i] = Math.max(LEAGUE_MINIMUM, LEAGUE_MINIMUM + (result[i] - LEAGUE_MINIMUM) * correction);
    });
  }

  return result;
}

async function main() {
  const seasonInfo = await store.getSeasonInfo();
  const ceiling = store.getCapCeiling(seasonInfo.seasonNumber);
  const target = Math.round(ceiling * TARGET_FACTOR * 1000) / 1000;
  console.log(`Season ${seasonInfo.seasonNumber} ceiling: $${ceiling}M — target per team: $${target}M\n`);

  const teams = await store.getTeams();
  for (const team of teams) {
    const roster = await store.getPlayersByTeam(team.id);
    const active = roster.filter((p) => p.lineupSlot !== "MINORS");
    const activeTotal = active.reduce((sum, p) => sum + p.capHit, 0);

    if (activeTotal <= target) {
      console.log(`${team.abbr}: already at $${activeTotal.toFixed(3)}M, under target — left alone.`);
      continue;
    }

    const factor = target / activeTotal;
    const scaledActive = scaleToTarget(
      active.map((p) => p.capHit),
      target
    );

    for (let i = 0; i < active.length; i++) {
      const newCapHit = round025(scaledActive[i]);
      await pool.query("UPDATE players SET cap_hit = $1 WHERE id = $2", [newCapHit, active[i].id]);
    }

    // MINORS players aren't part of the target sum (they don't count
    // against the cap), but still get the same per-team factor applied so
    // their contract numbers stay proportionally consistent with the rest
    // of the roster for if/when they get called up.
    const minorsPlayers = roster.filter((p) => p.lineupSlot === "MINORS");
    for (const p of minorsPlayers) {
      const newCapHit = Math.max(LEAGUE_MINIMUM, round025(p.capHit * factor));
      await pool.query("UPDATE players SET cap_hit = $1 WHERE id = $2", [newCapHit, p.id]);
    }

    const newActiveTotal = scaledActive.reduce((sum, v) => sum + v, 0);
    console.log(
      `${team.abbr}: $${activeTotal.toFixed(3)}M -> ~$${newActiveTotal.toFixed(3)}M (factor ${factor.toFixed(4)}, ${active.length} active + ${minorsPlayers.length} minors players)`
    );
  }

  await pool.end();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

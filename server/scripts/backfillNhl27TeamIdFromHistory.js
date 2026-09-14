// Corrects the earlier one-shot backfillNhl27TeamId.js, which set every
// player's nhl27_team_id to their CURRENT team_id — wrong for anyone who's
// already been traded or signed since the league started, since NHL 27's
// real roster still has them on whatever team they were on BEFORE that
// move. This walks each touched player's actual recorded transaction
// history backward from their current team to find their team before the
// earliest recorded move, which is what nhl27_team_id should be.
//
// Sources, in the order they're merged onto one timeline:
//  - trade_proposals (status='executed') and cpu_trade_offers
//    (status='accepted') both carry season_number/round/phase, so they're
//    ordered together via PHASE_SEQUENCE's real in-game sequence.
//  - human_trade_offers (status='accepted') has no season/round/phase, only
//    a real created_at timestamp — there's no historical mapping from real
//    time back to which season/round/phase was active then, so these are
//    treated as the MOST RECENT event for any player they touch (a
//    deliberate direct trade is unlikely to have been undone by an older,
//    already-processed round of CPU trade churn). Only a handful of rows
//    exist anywhere as of this writing, so this approximation is low-risk
//    — anyone it affects is printed below for a manual sanity check.
//  - free_agent_bids: no rows exist in any league as of this writing, so
//    signing-from-free-agency reconstruction isn't implemented here. If
//    that ever needs backfilling too, re-run against a league where it's
//    non-empty and extend this script first.
//
// Only ever needs to run once per league, same as backfillNhl27TeamId.js —
// rerunning after further real trades would incorrectly walk those back too.
const { pool } = require("../db");

const PHASE_SEQUENCE = [
  "free_agency",
  "trade_period",
  "set_roster",
  "roster_update",
  "regular_season",
  "playoffs",
  "post_playoff_trade",
  "draft",
  "progression",
  "resigning",
];
const phaseIndex = (phase) => {
  const i = PHASE_SEQUENCE.indexOf(phase);
  return i === -1 ? PHASE_SEQUENCE.length : i; // unknown phase sorts last, not first
};

async function main() {
  if (!process.env.LEAGUE) throw new Error("Set LEAGUE=test|development|production|og_hfl");

  const [{ rows: proposals }, { rows: cpuOffers }, { rows: humanOffers }] = await Promise.all([
    pool.query("SELECT * FROM trade_proposals WHERE status = 'executed'"),
    pool.query("SELECT * FROM cpu_trade_offers WHERE status = 'accepted'"),
    pool.query("SELECT * FROM human_trade_offers WHERE status = 'accepted' ORDER BY created_at, id"),
  ]);

  // One flat list of {playerId, from, to, sortKey} — sortKey is only
  // comparable within seasonRound events; human offers get a sortKey of
  // Infinity so they always sort after every seasonRound event below.
  const events = [];

  const addSeasonRoundEvent = (row, playerId, from, to) => {
    events.push({
      playerId,
      from,
      to,
      sortKey: [row.season_number, phaseIndex(row.phase), row.round, row.id],
    });
  };

  for (const r of proposals) {
    for (const pid of r.offered_player_ids) addSeasonRoundEvent(r, pid, r.proposing_team_id, r.target_team_id);
    for (const pid of r.requested_player_ids) addSeasonRoundEvent(r, pid, r.target_team_id, r.proposing_team_id);
  }
  for (const r of cpuOffers) {
    for (const pid of r.offered_player_ids) addSeasonRoundEvent(r, pid, r.cpu_team_id, r.target_team_id);
    for (const pid of r.requested_player_ids) addSeasonRoundEvent(r, pid, r.target_team_id, r.cpu_team_id);
  }
  // human_trade_offers events get pushed after sorting, tagged so they
  // always land last for whichever player(s) they touch.
  const humanEvents = [];
  for (const r of humanOffers) {
    for (const pid of r.offered_player_ids) humanEvents.push({ playerId: pid, from: r.proposing_team_id, to: r.target_team_id, offerId: r.id });
    for (const pid of r.requested_player_ids) humanEvents.push({ playerId: pid, from: r.target_team_id, to: r.proposing_team_id, offerId: r.id });
  }

  events.sort((a, b) => {
    for (let i = 0; i < 4; i++) {
      if (a.sortKey[i] !== b.sortKey[i]) return a.sortKey[i] - b.sortKey[i];
    }
    return 0;
  });

  const chainByPlayer = new Map();
  const addToChain = (e) => {
    if (!chainByPlayer.has(e.playerId)) chainByPlayer.set(e.playerId, []);
    chainByPlayer.get(e.playerId).push(e);
  };
  events.forEach(addToChain);
  humanEvents.forEach(addToChain);

  console.log(`Reconstructing nhl27_team_id for ${chainByPlayer.size} player(s) with recorded history...`);

  let updated = 0;
  const multiHop = [];
  for (const [playerId, chain] of chainByPlayer) {
    const originalTeamId = chain[0].from;
    await pool.query("UPDATE players SET nhl27_team_id = $1 WHERE id = $2", [originalTeamId, playerId]);
    updated++;
    if (chain.length > 1) multiHop.push({ playerId, hops: chain.length, originalTeamId });
  }

  console.log(`[${process.env.LEAGUE}] set nhl27_team_id from history for ${updated} player(s)`);
  if (multiHop.length > 0) {
    console.log("Players with more than one recorded move (worth a manual sanity check):");
    for (const m of multiHop) {
      console.log(`  player ${m.playerId}: ${m.hops} moves, reconstructed original team_id ${m.originalTeamId}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

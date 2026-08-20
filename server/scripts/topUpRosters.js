// One-off backfill: brings every existing team's roster up to the new
// 35-player standard (5 goalies, 10 defensemen, 20 forwards) by inserting
// new players into whichever position groups are short. Existing players
// (and their contracts/stats/trade history) are never touched or removed.
// Safe to re-run — a team already at/above a group's target is skipped for
// that group. Finishes by calling store.autoSetLineup for every team so the
// new depth doesn't just sit in MINORS with an empty line editor.
const { pool, withTransaction } = require("../db");
const store = require("../store");
const { firstNames, lastNames, SKATER_ATTRS, GOALIE_ATTRS, generatePotential } = require("../data");

function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function buildSkater(position) {
  const age = randInt(20, 35);
  const qualityBase = 60 + Math.random() * 35;
  const attributes = {};
  SKATER_ATTRS.forEach((attr) => {
    attributes[attr] = clamp(Math.round(qualityBase + (Math.random() * 20 - 10)), 40, 99);
  });
  const overall = Math.round(mean(SKATER_ATTRS.map((attr) => attributes[attr])));
  return {
    position,
    age,
    overall,
    attributes,
    capHit: Math.round((0.75 + (overall - 62) * 0.28) * 100) / 100,
    contractYearsLeft: 1 + randInt(0, 5),
    potential: generatePotential(age, overall),
    stats: { gamesPlayed: 0, goals: 0, assists: 0, points: 0, plusMinus: 0 },
  };
}

function buildGoalie() {
  const age = randInt(20, 35);
  const qualityBase = 65 + Math.random() * 30;
  const attributes = {};
  GOALIE_ATTRS.forEach((attr) => {
    attributes[attr] = clamp(Math.round(qualityBase + (Math.random() * 16 - 8)), 45, 99);
  });
  const overall = Math.round(mean(GOALIE_ATTRS.map((attr) => attributes[attr])));
  return {
    position: "G",
    age,
    overall,
    attributes,
    capHit: Math.round((0.85 + Math.random() * 6) * 100) / 100,
    contractYearsLeft: 1 + randInt(0, 5),
    potential: generatePotential(age, overall),
    stats: {
      gamesPlayed: 0,
      wins: 0,
      losses: 0,
      otLosses: 0,
      goalsAgainstAverage: 0,
      savePercentage: 0,
      shutouts: 0,
      _goalsAgainstTotal: 0,
      _shotsFacedTotal: 0,
    },
  };
}

async function main() {
  const { rows: teamRows } = await pool.query("SELECT id, city, name FROM teams ORDER BY id");
  const { rows: maxIdRows } = await pool.query("SELECT COALESCE(MAX(id), 0) AS max_id FROM players");
  let nextId = maxIdRows[0].max_id + 1;

  for (const team of teamRows) {
    const { rows: playerRows } = await pool.query("SELECT position, jersey_number FROM players WHERE team_id = $1", [
      team.id,
    ]);
    const counts = { G: 0, D: 0, F: 0 };
    const usedJerseys = new Set();
    playerRows.forEach((p) => {
      usedJerseys.add(p.jersey_number);
      if (p.position === "G") counts.G++;
      else if (p.position === "D") counts.D++;
      else counts.F++;
    });

    const deficits = { G: Math.max(0, 5 - counts.G), D: Math.max(0, 10 - counts.D), F: Math.max(0, 20 - counts.F) };
    const forwardCycle = ["C", "LW", "RW"];
    const newPlayers = [];
    for (let i = 0; i < deficits.G; i++) newPlayers.push(buildGoalie());
    for (let i = 0; i < deficits.D; i++) newPlayers.push(buildSkater("D"));
    for (let i = 0; i < deficits.F; i++) newPlayers.push(buildSkater(forwardCycle[i % 3]));

    if (newPlayers.length === 0) {
      console.log(`${team.city} ${team.name}: already at 35 (G${counts.G}/D${counts.D}/F${counts.F})`);
      continue;
    }

    await withTransaction(async (client) => {
      for (const p of newPlayers) {
        let jersey;
        do {
          jersey = randInt(4, 98);
        } while (usedJerseys.has(jersey));
        usedJerseys.add(jersey);
        const first = firstNames[Math.floor(Math.random() * firstNames.length)];
        const last = lastNames[Math.floor(Math.random() * lastNames.length)];
        await client.query(
          `INSERT INTO players
             (id, team_id, name, position, jersey_number, age, overall, cap_hit,
              contract_years_left, in_game_status, roster_assignment, attributes, potential, stats)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'needs_update','MINORS',$10,$11,$12)`,
          [
            nextId,
            team.id,
            `${first} ${last}`,
            p.position,
            jersey,
            p.age,
            p.overall,
            p.capHit,
            p.contractYearsLeft,
            JSON.stringify(p.attributes),
            JSON.stringify(p.potential),
            JSON.stringify(p.stats),
          ]
        );
        nextId++;
      }
    });
    console.log(
      `${team.city} ${team.name}: added ${newPlayers.length} (G+${deficits.G} D+${deficits.D} F+${deficits.F}), was G${counts.G}/D${counts.D}/F${counts.F}`
    );
  }

  console.log("Auto-setting lineups for all teams...");
  for (const team of teamRows) {
    await store.autoSetLineup(team.id);
  }
  console.log("Done.");
}

main()
  .then(() => pool.end())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

// One-off analysis script: simulate 200 synthetic skaters from age 18
// (70 OVR) through age 40 using the app's real progression math
// (server/store.js's progressPlayer — age curve, performance modifier,
// category bias), and write the year-by-year overall for each to a CSV.
//
// Note: server/store.js's progressPlayer does NOT currently read
// player.potential at all — Potential is a scouted projection used for
// display and trade value, not a mechanical driver of growth in the live
// app. For this simulation to actually show potential shaping careers (the
// whole point of varying it), this script rolls a "realized ceiling" per
// player (see rollRealizedCeiling()) and dampens progressPlayer's raw growth
// as each player closes in on it (see runCareer()). That layer is local to
// this script only; it does not change how the live app progresses players.
const fs = require("fs");
const path = require("path");
const { progressPlayer } = require("../store");
const { SKATER_ATTRS } = require("../data");

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

const FIRST_NAMES = [
  "Jake", "Connor", "Mason", "Tyler", "Owen", "Ryan", "Logan", "Carter",
  "Wyatt", "Ethan", "Nolan", "Blake", "Colton", "Dylan", "Hunter", "Brady",
  "Aiden", "Cole", "Landon", "Chase",
];

const LAST_NAMES = [
  "Sorensen", "MacKenzie", "Reilly", "Novak", "Petrov", "Larsson", "Whitfield", "Duncan",
  "Hawkins", "Bryant",
];

const POTENTIAL_LEVELS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];
const CONFIDENCES = ["red", "yellow", "green"];
// Confidence is a straight probability of actually reaching potential, not a
// continuous multiplier — the previous version scaled realized ceiling by
// trust smoothly (green always ~75-115% of the gap, red always ~30-46%),
// which made green players reliably better every single time rather than
// "usually better, but not guaranteed." This is a real per-player coin flip.
const HIT_CHANCE = { green: 1, yellow: 0.75, red: 0.25 };
// Confidence now shifts *what hitting potential even means*, not just the
// odds of getting there: yellow is the calibrated target itself, red hits a
// bit below it (risky — worse ceiling AND worse odds), green hits a bit
// above it (a "sure thing" — better ceiling AND certain odds).
const CONFIDENCE_CEILING_OFFSET = { green: 3, yellow: 0, red: -3 };
const STARTING_OVERALL = 70;

// Expected overall when a YELLOW-confidence player fully hits their
// potential — least-squares fit to user-provided targets: 2.5*->74, 3*->77,
// 3.5*->81, 4*->85, 4.5*->89, 5*->93 (max error 0.48 OVR across all six
// anchor points). Still floored at the starting 70 OVR — a 0.5/1-star
// ceiling this formula implies (~58/~62) is below where every player
// starts, which just means "no growth room," not "drop below where he started."
function ceilingFromStars(stars) {
  return Math.max(STARTING_OVERALL, 54.2381 + 7.7143 * stars);
}

// Rolled ONCE per player (a scouting grade doesn't change season to season):
// confidence sets both the odds of actually hitting potential at all (green
// always hits, yellow hits 75% of the time, red only 25%) AND, now, the
// ceiling reached if they do — see CONFIDENCE_CEILING_OFFSET above. A miss
// isn't total failure, just a real shortfall — they still realize some of
// the (confidence-adjusted) gap, just a small, random slice of it.
function rollRealizedCeiling(stars, confidence) {
  const ceiling = Math.max(STARTING_OVERALL, ceilingFromStars(stars) + CONFIDENCE_CEILING_OFFSET[confidence]);
  const hitPotential = Math.random() < HIT_CHANCE[confidence];

  if (hitPotential) {
    const realizedCeiling = clamp(ceiling - Math.random() * 0.5, STARTING_OVERALL, 99);
    return { realizedCeiling, hitPotential };
  }

  const bustFraction = 0.1 + Math.random() * 0.35;
  const realizedCeiling = STARTING_OVERALL + (ceiling - STARTING_OVERALL) * bustFraction;
  return { realizedCeiling, hitPotential };
}

function makePlayer(index) {
  const stars = POTENTIAL_LEVELS[index % POTENTIAL_LEVELS.length];
  const confidence = CONFIDENCES[index % CONFIDENCES.length];
  const first = FIRST_NAMES[index % FIRST_NAMES.length];
  const last = LAST_NAMES[Math.floor(index / FIRST_NAMES.length) % LAST_NAMES.length];

  const attributes = {};
  SKATER_ATTRS.forEach((attr) => {
    attributes[attr] = 70;
  });

  return {
    id: index + 1,
    teamId: 1,
    name: `${first} ${last}`,
    position: "C",
    age: 18,
    overall: 70,
    attributes,
    potential: { stars, confidence },
    stats: { gamesPlayed: 0, goals: 0, assists: 0, points: 0, plusMinus: 0 },
  };
}

// Assumes a full season played every year, with points randomized +/-25%
// around what's expected for the player's current overall — the same
// expectedPpg formula performanceModifier() uses internally.
function simulateSeason(player) {
  const gamesPlayed = 25;
  const expectedPpg = 0.15 + (player.overall - 60) * 0.012;
  const actualPpg = Math.max(0, expectedPpg * (0.75 + Math.random() * 0.5));
  const points = Math.round(actualPpg * gamesPlayed);
  const goals = Math.round(points * 0.45);
  player.stats = { gamesPlayed, goals, assists: points - goals, points, plusMinus: 0 };
}

function runCareer(player) {
  const { realizedCeiling, hitPotential } = rollRealizedCeiling(player.potential.stars, player.potential.confidence);
  const overallsByAge = { 18: player.overall };

  for (let age = 18; age < 40; age++) {
    simulateSeason(player);
    const result = progressPlayer(player); // base growth: age curve + performance + category bias

    // Saturating growth: dampen (never amplify) *growth* as the player
    // closes in on their realized ceiling, proportionally, so every
    // attribute scales down together rather than growth just stopping
    // abruptly at one number. Decline (aging past prime) is never dampened
    // — a bust risk that never panned out still ages normally.
    const rawOverallDelta = result.newOverall - player.overall;
    let scale = 1;
    if (rawOverallDelta > 0) {
      const headroom = realizedCeiling - player.overall;
      // Divisor tightened from /8 to /4.5: the wider curve left a
      // consistent 1-3 OVR shortfall against the target hit-potential
      // averages even after many growth years — this converges faster so
      // "hit" outcomes land much closer to the actual calibrated ceiling.
      const dampingFactor = headroom <= 0 ? 0.05 : clamp(headroom / 4.5, 0.05, 1);
      scale = dampingFactor;
    }

    const newAttributes = {};
    SKATER_ATTRS.forEach((attr) => {
      const delta = result.attributeDeltas[attr] * scale;
      newAttributes[attr] = clamp(Math.round(player.attributes[attr] + delta), 25, 99);
    });
    const newOverall = Math.round(mean(SKATER_ATTRS.map((attr) => newAttributes[attr])));

    player.age = result.newAge;
    player.attributes = newAttributes;
    player.overall = newOverall;
    player.stats = result.resetStats;

    overallsByAge[player.age] = player.overall;
  }

  return { overallsByAge, hitPotential };
}

const CONFIDENCE_LABELS = {
  red: "Red (Low)",
  yellow: "Yellow (Medium)",
  green: "Green (High)",
};

function main() {
  const players = Array.from({ length: 200 }, (_, i) => makePlayer(i));
  const ages = [];
  for (let a = 18; a <= 40; a++) ages.push(a);

  const header = ["name", "potential", "confidence", "hit_potential", ...ages.map((a) => `age_${a}`)];
  const rows = [header.join(",")];

  players.forEach((player) => {
    const stars = player.potential.stars;
    const confidenceLabel = CONFIDENCE_LABELS[player.potential.confidence];
    const { overallsByAge, hitPotential } = runCareer(player);
    const row = [player.name, stars, confidenceLabel, hitPotential ? "Yes" : "No", ...ages.map((a) => overallsByAge[a])];
    rows.push(row.join(","));
  });

  const outPath = path.join(__dirname, "..", "..", "career_simulation.csv");
  fs.writeFileSync(outPath, rows.join("\n"));
  console.log(`Wrote ${players.length} careers (ages 18-40) to ${outPath}`);
}

main();

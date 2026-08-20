// Mock data for the Hockey Franchise League prototype.
// 8 teams x 35 players (20 forwards, 10 defensemen, 5 goalies) = 280 total,
// matching a real NHL roster's depth (enough bodies for 4 forward lines, 3
// defense pairs, and starter+backup goalie with bench/scratch/minors left over).
// (This buildPlayers()-based mock roster only ever runs against a genuinely
// empty database — see seed.js's seedIfEmpty — the real 32-team league now
// running was loaded by scripts/importRealRosters.js instead, which reads
// straight from the CSVs in /Rosters and does not use this generator.)

const { generateRoundRobinSchedule } = require("./scheduleGenerator");

// All 32 real NHL franchises, real conference/division alignment. ids 1-8
// are the original mock franchises (kept stable across the 8->32 expansion
// so existing FKs — users.team_id for the detroit/nashville GM logins,
// historical draft_order/season_results rows — don't need to change); ids
// 9-32 are the 24 teams added for the expansion, in alphabetical-by-city
// order. Only Detroit and Nashville are human-controlled.
const teams = [
  { id: 1, city: "Boston", name: "Bruins", abbr: "BOS", conference: "Eastern", division: "Atlantic", isHumanControlled: false },
  { id: 2, city: "Toronto", name: "Maple Leafs", abbr: "TOR", conference: "Eastern", division: "Atlantic", isHumanControlled: false },
  { id: 3, city: "Chicago", name: "Blackhawks", abbr: "CHI", conference: "Western", division: "Central", isHumanControlled: false },
  { id: 4, city: "Nashville", name: "Predators", abbr: "NSH", conference: "Western", division: "Central", isHumanControlled: true },
  { id: 5, city: "Dallas", name: "Stars", abbr: "DAL", conference: "Western", division: "Central", isHumanControlled: false },
  { id: 6, city: "Detroit", name: "Red Wings", abbr: "DET", conference: "Eastern", division: "Atlantic", isHumanControlled: true },
  { id: 7, city: "Colorado", name: "Avalanche", abbr: "COL", conference: "Western", division: "Central", isHumanControlled: false },
  { id: 8, city: "Vegas", name: "Golden Knights", abbr: "VGK", conference: "Western", division: "Pacific", isHumanControlled: false },
  { id: 9, city: "Anaheim", name: "Ducks", abbr: "ANA", conference: "Western", division: "Pacific", isHumanControlled: false },
  { id: 10, city: "Buffalo", name: "Sabres", abbr: "BUF", conference: "Eastern", division: "Atlantic", isHumanControlled: false },
  { id: 11, city: "Calgary", name: "Flames", abbr: "CGY", conference: "Western", division: "Pacific", isHumanControlled: false },
  { id: 12, city: "Carolina", name: "Hurricanes", abbr: "CAR", conference: "Eastern", division: "Metropolitan", isHumanControlled: false },
  { id: 13, city: "Columbus", name: "Blue Jackets", abbr: "CBJ", conference: "Eastern", division: "Metropolitan", isHumanControlled: false },
  { id: 14, city: "Edmonton", name: "Oilers", abbr: "EDM", conference: "Western", division: "Pacific", isHumanControlled: false },
  { id: 15, city: "Florida", name: "Panthers", abbr: "FLA", conference: "Eastern", division: "Atlantic", isHumanControlled: false },
  { id: 16, city: "Los Angeles", name: "Kings", abbr: "LAK", conference: "Western", division: "Pacific", isHumanControlled: false },
  { id: 17, city: "Minnesota", name: "Wild", abbr: "MIN", conference: "Western", division: "Central", isHumanControlled: false },
  { id: 18, city: "Montreal", name: "Canadiens", abbr: "MTL", conference: "Eastern", division: "Atlantic", isHumanControlled: false },
  { id: 19, city: "New Jersey", name: "Devils", abbr: "NJD", conference: "Eastern", division: "Metropolitan", isHumanControlled: false },
  { id: 20, city: "New York", name: "Islanders", abbr: "NYI", conference: "Eastern", division: "Metropolitan", isHumanControlled: false },
  { id: 21, city: "New York", name: "Rangers", abbr: "NYR", conference: "Eastern", division: "Metropolitan", isHumanControlled: false },
  { id: 22, city: "Ottawa", name: "Senators", abbr: "OTT", conference: "Eastern", division: "Atlantic", isHumanControlled: false },
  { id: 23, city: "Philadelphia", name: "Flyers", abbr: "PHI", conference: "Eastern", division: "Metropolitan", isHumanControlled: false },
  { id: 24, city: "Pittsburgh", name: "Penguins", abbr: "PIT", conference: "Eastern", division: "Metropolitan", isHumanControlled: false },
  { id: 25, city: "San Jose", name: "Sharks", abbr: "SJS", conference: "Western", division: "Pacific", isHumanControlled: false },
  { id: 26, city: "Seattle", name: "Kraken", abbr: "SEA", conference: "Western", division: "Pacific", isHumanControlled: false },
  { id: 27, city: "St. Louis", name: "Blues", abbr: "STL", conference: "Western", division: "Central", isHumanControlled: false },
  { id: 28, city: "Tampa Bay", name: "Lightning", abbr: "TBL", conference: "Eastern", division: "Atlantic", isHumanControlled: false },
  { id: 29, city: "Utah", name: "Mammoth", abbr: "UTA", conference: "Western", division: "Central", isHumanControlled: false },
  { id: 30, city: "Vancouver", name: "Canucks", abbr: "VAN", conference: "Western", division: "Pacific", isHumanControlled: false },
  { id: 31, city: "Washington", name: "Capitals", abbr: "WSH", conference: "Eastern", division: "Metropolitan", isHumanControlled: false },
  { id: 32, city: "Winnipeg", name: "Jets", abbr: "WPG", conference: "Western", division: "Central", isHumanControlled: false },
];

// 20 forwards (split 7 C / 7 LW / 6 RW) + 10 defensemen per team — goalies
// are appended separately below (5 per team, not part of this template).
const rosterTemplates = [
  [
    ...Array(7).fill("C"),
    ...Array(7).fill("LW"),
    ...Array(6).fill("RW"),
    ...Array(10).fill("D"),
  ],
];

// Matches NHL26's player-card attribute groupings (see Reference/NHL26 STATS.jpeg).
// Goalies use their own, separate NHL26-accurate set (see GOALIE_ATTRIBUTE_CATEGORIES below).
const ATTRIBUTE_CATEGORIES = {
  puckSkills: ["deking", "handEye", "passing", "puckControl"],
  senses: ["discipline", "offAwareness", "poise"],
  shooting: ["slapShotAccuracy", "slapShotPower", "wristShotAccuracy", "wristShotPower"],
  defense: ["defAwareness", "faceoffs", "shotBlocking", "stickChecking"],
  skating: ["acceleration", "agility", "balance", "endurance", "speed"],
  physical: ["aggressiveness", "bodyChecking", "durability", "fightingSkill", "strength"],
};

const SKATER_ATTRS = Object.values(ATTRIBUTE_CATEGORIES).flat();

// Matches NHL26's goalie attribute groupings (see Reference/NHL26 Goalie Stats.webp).
const GOALIE_ATTRIBUTE_CATEGORIES = {
  low: ["gloveLow", "stickLow", "fiveHole"],
  hands: ["gloveHigh", "stickHigh", "passing"],
  quickness: ["speed", "agility", "pokeCheck", "durability", "endurance"],
  positioning: ["reboundControl", "vision", "breakaway", "angles", "recover"],
};

const GOALIE_ATTRS = Object.values(GOALIE_ATTRIBUTE_CATEGORIES).flat();

const firstNames = [
  "Jake", "Connor", "Mason", "Tyler", "Owen", "Ryan", "Logan", "Carter",
  "Wyatt", "Ethan", "Nolan", "Blake", "Colton", "Dylan", "Hunter", "Brady",
  "Aiden", "Cole", "Landon", "Chase", "Kyle", "Trevor", "Dawson", "Grady",
  "Marcus", "Elias", "Felix", "Anders", "Viktor", "Lukas", "Niklas", "Mikko",
  "Igor", "Pavel", "Dmitri", "Sami", "Erik", "Axel", "Gustav", "Henrik",
  "Miles", "Rhys", "Jaxon", "Bo", "Cade", "Sawyer", "Callum", "Reid",
];

const lastNames = [
  "Sorensen", "MacKenzie", "Reilly", "Novak", "Petrov", "Larsson", "Whitfield", "Duncan",
  "Hawkins", "Bryant", "Kowalski", "Fontaine", "Osgood", "Sutter", "Kessler", "Marchetti",
  "Boucher", "Lindqvist", "Vasquez", "Delgado", "Ferraro", "Nystrom", "Callahan", "Doyle",
  "Strand", "Whitaker", "Renner", "Kozlov", "Aho", "Lindgren", "Bergstrom", "Carrick",
  "Danforth", "Ellery", "Foss", "Grover", "Halvorsen", "Ibsen", "Jorgensen", "Kallio",
  "Lund", "Moreau", "Nilsen", "Ostrander", "Pelletier", "Quist", "Rask", "Sundqvist",
];

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

const rand = seededRandom(1337);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mean(values) {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// Ceiling rating (0.5-5 stars) plus a confidence color for reaching it.
// Confidence is a one-time "scouting grade" set at creation, not recomputed
// each season — it's read back through an age-30+ white override elsewhere.
function generatePotential(age, overall) {
  const headroomBase = age <= 21 ? 16 : age <= 24 ? 11 : age <= 27 ? 6 : age <= 29 ? 2 : 0;
  const headroom = Math.max(0, headroomBase + Math.round(rand() * 6 - 3));
  const ceiling = clamp(overall + headroom, overall, 99);
  const stars = clamp(Math.round(((ceiling / 99) * 5) * 2) / 2, 0.5, 5);

  const roll = rand();
  let confidence;
  if (headroom <= 3) {
    confidence = roll < 0.65 ? "green" : "yellow";
  } else if (headroom >= 13) {
    confidence = roll < 0.55 ? "red" : "yellow";
  } else {
    confidence = roll < 0.35 ? "green" : roll < 0.75 ? "yellow" : "red";
  }

  return { stars, confidence };
}

// Skater season stats start at zero and are filled in as games are simmed or
// scores are submitted, rather than being seeded randomly, so totals always
// reconcile with the games actually recorded in `schedule`.
function buildPlayers() {
  let id = 1;
  const players = [];
  teams.forEach((team) => {
    const positions = rosterTemplates[0];
    positions.forEach((pos, idx) => {
      const first = firstNames[(id * 3 + idx) % firstNames.length];
      const last = lastNames[(id * 7 + idx) % lastNames.length];
      const age = 20 + Math.floor(rand() * 16); // 20-35
      const qualityBase = 60 + rand() * 35; // 60-95ish

      const attributes = {};
      SKATER_ATTRS.forEach((attr) => {
        attributes[attr] = clamp(Math.round(qualityBase + (rand() * 20 - 10)), 40, 99);
      });
      const overall = Math.round(mean(SKATER_ATTRS.map((attr) => attributes[attr])));

      players.push({
        id,
        teamId: team.id,
        name: `${first} ${last}`,
        position: pos,
        jerseyNumber: 4 + ((id * 5) % 92),
        age,
        overall,
        capHit: Math.round((0.75 + (overall - 62) * 0.28) * 100) / 100, // $M, rough curve
        contractYearsLeft: 1 + Math.floor(rand() * 6),
        inGameStatus: rand() < 0.15 ? "needs_update" : rand() < 0.3 ? "not_created" : "active",
        attributes,
        potential: generatePotential(age, overall),
        stats: { gamesPlayed: 0, goals: 0, assists: 0, points: 0, plusMinus: 0 },
      });
      id++;
    });
    // 5 goalies per team, appended after the 30 skaters
    for (let g = 0; g < 5; g++) {
      const first = firstNames[(id * 3 + g) % firstNames.length];
      const last = lastNames[(id * 7 + g) % lastNames.length];
      const goalieAge = 20 + Math.floor(rand() * 16);
      const goalieQualityBase = 65 + rand() * 30; // 65-95ish

      const goalieAttributes = {};
      GOALIE_ATTRS.forEach((attr) => {
        goalieAttributes[attr] = clamp(Math.round(goalieQualityBase + (rand() * 16 - 8)), 45, 99);
      });
      const goalieOverall = Math.round(mean(GOALIE_ATTRS.map((attr) => goalieAttributes[attr])));

      players.push({
        id,
        teamId: team.id,
        name: `${first} ${last}`,
        position: "G",
        jerseyNumber: 30 + (id % 40),
        age: goalieAge,
        overall: goalieOverall,
        capHit: Math.round((0.85 + rand() * 6) * 100) / 100,
        contractYearsLeft: 1 + Math.floor(rand() * 6),
        inGameStatus: rand() < 0.15 ? "needs_update" : rand() < 0.3 ? "not_created" : "active",
        attributes: goalieAttributes,
        potential: generatePotential(goalieAge, goalieOverall),
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
      });
      id++;
    }
  });
  return players;
}

const players = buildPlayers();

// Anchor date for the mock schedule. Games before this are "already played";
// games on/after it are upcoming. Kept separate from wall-clock time so the
// prototype's story stays coherent regardless of when the server runs.
const TODAY = "2026-07-30";

// All games start unscored. Score entry (manual for human_vs_human, auto-sim
// for anything involving a CPU team) is handled in store.js at runtime.
// Season 1 is anchored so roughly half its games fall before TODAY, so the
// prototype opens mid-season with real standings/stats already in place.
function buildInitialSchedule() {
  const anchor = new Date(TODAY);
  anchor.setDate(anchor.getDate() - 21);
  const startDate = anchor.toISOString().slice(0, 10);

  const games = generateRoundRobinSchedule(
    teams.map((t) => t.id),
    { startDate, roundsPerMatchup: 2, daysBetweenRounds: 3 }
  );
  return games.map((game, idx) => ({ id: idx + 1, ...game }));
}

const schedule = buildInitialSchedule();

module.exports = {
  teams,
  players,
  schedule,
  TODAY,
  ATTRIBUTE_CATEGORIES,
  SKATER_ATTRS,
  GOALIE_ATTRIBUTE_CATEGORIES,
  GOALIE_ATTRS,
  generatePotential,
  firstNames,
  lastNames,
};

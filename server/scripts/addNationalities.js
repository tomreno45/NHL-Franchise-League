// Backfills players.nationality (see schema.sql) from the NHL's own public
// player-search API (used by NHL.com's search box — no API key, no rate
// limit documented but treated politely here via bounded concurrency).
// Run with LEAGUE=<slug> node scripts/addNationalities.js — safe to re-run,
// it only ever fills nationality in, never overwrites an existing value
// (so a partial run, or adding new players later, can just be re-run).
const { pool } = require("../db");
const { teams: TEAM_DEFS } = require("../data");

const SEARCH_URL = "https://search.d3.nhle.com/api/v1/search/player";
const CONCURRENCY = 8;

// Real NHL team abbreviations occasionally differ from this app's own
// (see importOgHflRosters.js's cal/was note for the same kind of mismatch
// in a different source) — none known here, but keeping this as an easy
// place to add an override if a team's real-API abbrev ever proves to.
const TEAM_ABBR_OVERRIDES = {};

// NHL API birthCountry -> full country name. Covers every nationality
// that's actually shown up in the league (real 2026-27 NHL rosters plus
// their prospect pools); an unmapped code falls back to the raw code
// itself with a console.warn so a genuinely new one doesn't get silently
// stored as junk.
const COUNTRY_NAMES = {
  CAN: "Canada",
  USA: "United States",
  SWE: "Sweden",
  FIN: "Finland",
  RUS: "Russia",
  CZE: "Czechia",
  CZR: "Czechia",
  SVK: "Slovakia",
  DEU: "Germany",
  GER: "Germany",
  CHE: "Switzerland",
  SUI: "Switzerland",
  DNK: "Denmark",
  DEN: "Denmark",
  NOR: "Norway",
  AUT: "Austria",
  FRA: "France",
  LVA: "Latvia",
  LAT: "Latvia",
  SVN: "Slovenia",
  SLO: "Slovenia",
  BLR: "Belarus",
  UKR: "Ukraine",
  GBR: "United Kingdom",
  ITA: "Italy",
  JPN: "Japan",
  KOR: "South Korea",
  AUS: "Australia",
  BEL: "Belgium",
  POL: "Poland",
  HUN: "Hungary",
  KAZ: "Kazakhstan",
  EST: "Estonia",
  LTU: "Lithuania",
  NLD: "Netherlands",
  ESP: "Spain",
  CHN: "China",
  BRA: "Brazil",
  MEX: "Mexico",
  ISR: "Israel",
  IRL: "Ireland",
  NZL: "New Zealand",
  ZAF: "South Africa",
  HRV: "Croatia",
  SRB: "Serbia",
  ISL: "Iceland",
  MDA: "Moldova",
};

// The NHL's own search index uses each player's official/registered first
// name, which doesn't always match what this league's OCR source used —
// e.g. our data has "Matt Boldy" and "Gabe Vilardi", the NHL has "Matt
// Boldy" (matches) but officially "Gabriel Vilardi" (doesn't) — and the
// reverse also happens ("Christopher Tanev" here vs official "Chris
// Tanev"). Tried in both directions as an alternate search term whenever
// the literal name comes up empty. Not exhaustive — just the pairs that
// actually showed up as real misses in this league's roster.
const NICKNAME_PAIRS = [
  ["Matt", "Matthew"],
  ["Chris", "Christopher"],
  ["Nick", "Nicholas"],
  ["Mike", "Michael"],
  ["Josh", "Joshua"],
  ["Zach", "Zachary"],
  ["Alex", "Alexander"],
  ["Will", "William"],
  ["Sam", "Samuel"],
  ["Ben", "Benjamin"],
  ["Danny", "Daniel"],
  ["Dan", "Daniel"],
  ["Tony", "Anthony"],
  ["Joe", "Joseph"],
  ["Joey", "Joseph"],
  ["Charlie", "Charles"],
  ["Gabe", "Gabriel"],
  ["Rob", "Robert"],
  ["Bob", "Robert"],
  ["Jim", "James"],
  ["Jimmy", "James"],
  ["Tom", "Thomas"],
  ["Tommy", "Thomas"],
  ["Andy", "Andrew"],
  ["Greg", "Gregory"],
  ["Jake", "Jacob"],
  ["Cam", "Cameron"],
  ["Pat", "Patrick"],
  ["Steve", "Steven"],
  ["Ken", "Kenneth"],
  ["Ed", "Edward"],
  ["Vinny", "Vincent"],
  ["Vince", "Vincent"],
  ["Nate", "Nathan"],
  ["Jon", "Jonathan"],
  ["Johnny", "Jonathan"],
];

// Candidate query strings to try, in order, for one player name: the
// literal name, hyphens normalized to spaces (catches both "Aston-Reese"
// vs "Aston Reese" and "Sandin Pellikka" vs "Sandin-Pellikka" mismatches
// either direction), and a nickname swap of the first name layered on top
// of both. Stops at the first candidate that resolves (see
// resolveNationality) rather than trying all of them every time.
function nameCandidates(name) {
  const variants = new Set([name, name.replace(/-/g, " ")]);
  // Only hyphenate the LAST space (a compound surname like "Sandin
  // Pellikka" vs official "Sandin-Pellikka"), not every space — replacing
  // every space with a hyphen mangles the first/last name boundary instead.
  const tokens = name.split(" ");
  if (tokens.length >= 3) {
    variants.add([...tokens.slice(0, -2), tokens.slice(-2).join("-")].join(" "));
  }
  const withNicknames = new Set(variants);
  for (const variant of variants) {
    const [first, ...rest] = variant.split(" ");
    for (const [short, formal] of NICKNAME_PAIRS) {
      if (first.toLowerCase() === short.toLowerCase()) withNicknames.add([formal, ...rest].join(" "));
      if (first.toLowerCase() === formal.toLowerCase()) withNicknames.add([short, ...rest].join(" "));
    }
  }
  return [...withNicknames];
}

function countryName(code) {
  if (!code) return null;
  const name = COUNTRY_NAMES[code];
  if (!name) {
    console.warn(`  unmapped birthCountry code "${code}" — storing raw code`);
    return code;
  }
  return name;
}

function normName(s) {
  return (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
}

async function searchPlayer(name, active) {
  const url = `${SEARCH_URL}?culture=en-us&limit=25&q=${encodeURIComponent(name)}&active=${active}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`NHL search API ${res.status} for "${name}"`);
  return res.json();
}

// Tries active-roster players first (the common case, and avoids pulling in
// a same-named retired player), then falls back to the full historical
// index for anyone not currently active (older UFAs, depth guys between
// contracts). Prefers a result on the player's actual team when more than
// one real person shares the exact name (there are a few in the NHL).
async function resolveNationality(player, teamAbbr) {
  for (const candidate of nameCandidates(player.name)) {
    const target = normName(candidate);
    for (const active of [true, false]) {
      const results = await searchPlayer(candidate, active);
      const exact = results.filter((r) => normName(r.name) === target);
      if (exact.length === 0) continue;

      const teamMatch = exact.find((r) => (r.teamAbbrev || r.lastTeamAbbrev || "").toUpperCase() === teamAbbr);
      if (teamMatch) return { country: teamMatch.birthCountry, confidence: "team-matched" };

      if (exact.length === 1) return { country: exact[0].birthCountry, confidence: "name-only (unique)" };
    }
  }
  return null;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main() {
  const teamAbbrById = new Map(TEAM_DEFS.map((t) => [t.id, (TEAM_ABBR_OVERRIDES[t.abbr] || t.abbr).toUpperCase()]));

  const { rows } = await pool.query(
    "SELECT id, name, team_id FROM players WHERE nationality IS NULL ORDER BY id"
  );
  console.log(`${rows.length} players missing nationality. Querying the NHL search API...`);

  let matched = 0;
  let teamMatched = 0;
  const unmatched = [];

  await mapWithConcurrency(rows, CONCURRENCY, async (player, i) => {
    const teamAbbr = teamAbbrById.get(player.team_id) || "";
    try {
      const result = await resolveNationality(player, teamAbbr);
      if (!result) {
        unmatched.push(player.name);
        return;
      }
      const nationality = countryName(result.country);
      await pool.query("UPDATE players SET nationality = $1 WHERE id = $2", [nationality, player.id]);
      matched++;
      if (result.confidence === "team-matched") teamMatched++;
      if ((i + 1) % 200 === 0) console.log(`  ...${i + 1}/${rows.length} processed`);
    } catch (err) {
      console.warn(`  lookup failed for "${player.name}": ${err.message}`);
      unmatched.push(player.name);
    }
  });

  console.log(`\nMatched ${matched}/${rows.length} (${teamMatched} confirmed by current team, ${matched - teamMatched} by unique name).`);
  if (unmatched.length > 0) {
    console.log(`\n${unmatched.length} unmatched (left NULL, safe to re-run this script later):`);
    unmatched.forEach((n) => console.log(`  - ${n}`));
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

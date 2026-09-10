// One-time import for the new "OG HFL" league: builds its entire player
// pool, contracts, and draft-pick ownership from the 3 files in
// ../../../Roster Database/ (a full-league OCR scrape of real NHL 27
// player cards, plus real cap-hit and draft-pick-trade data pulled from
// PuckPedia). Run with LEAGUE=og_hfl node scripts/importOgHflRosters.js —
// db.js refuses to run without an explicit LEAGUE, specifically so this
// can never be pointed at the wrong database by accident.
//
// Modeled on importRealRosters.js (same wipe-and-rebuild shape, same
// "no history archive" tradeoff), but three real data sources instead of
// one CSV per team with generated attributes:
//   - NHL_All_Teams_Players.xlsx: real scraped attributes for all 32 teams
//     (goalies included — this data has actual goalie attribute columns,
//     unlike the old Rosters/ CSVs which had none and had to fake them).
//   - all_teams_salaries.csv: real AAV/years-remaining per player, used
//     directly instead of the app's own computeContractDemand formula
//     wherever a name match is found (join key: team + normalized name).
//   - all_teams_draft_picks.csv: real 2027-2031 draft-pick ownership,
//     including trade history, imported straight into draft_picks
//     (season_number = real year - 2026, matching CURRENT_SEASON_START in
//     Rosters/parse_puckpedia.py, so 2027 is this league's season-1 draft).
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const { pool } = require("../db");
const store = require("../store");
const { SKATER_ATTRS, GOALIE_ATTRS, teams: TEAM_DEFS } = require("../data");
const { generateNhlStyleSchedule } = require("../scheduleGenerator");

const DATA_DIR = path.join(__dirname, "..", "..", "Roster Database");
const REAL_SEASON_BASE_YEAR = 2026; // draft year N -> season_number (N - 2026), matches parse_puckpedia.py

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}
// Strips accents before comparing — the xlsx scrape kept real diacritics
// ("Guénette", "Söderblom", "Niemelä") but the salary CSV's export flattened
// them to plain ASCII ("Guenette", "Soderblom", "Niemela"). Without this,
// every accented name in the xlsx silently failed to match its real salary
// row and fell back to computed demand instead — found by auditing exactly
// which players didn't match after the initial import.
function normName(s) {
  return (s || "")
    .trim()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ");
}

// Common English nickname/full-name first-name pairs — the two sources
// disagree on which form they use often enough to be worth a small fixed
// table (Matt Boldy vs. Matthew Boldy is the one that got reported; the
// same pattern turned up ~20 more times on auditing). Deliberately just
// well-known 1:1 pairs, not fuzzy matching — a wrong guess here would
// silently apply the wrong person's salary.
const NICKNAME_PAIRS = [
  ["matt", "matthew"],
  ["will", "william"],
  ["nick", "nicholas"],
  ["mike", "michael"],
  ["alex", "alexander"],
  ["joe", "joseph"],
  ["chris", "christopher"],
  ["zach", "zachary"],
  ["sam", "samuel"],
  ["ben", "benjamin"],
  ["josh", "joshua"],
  ["dan", "daniel"],
  ["tom", "thomas"],
  ["andy", "andrew"],
  ["rob", "robert"],
  ["jack", "jackson"],
  ["nate", "nathan"],
  ["tony", "anthony"],
  ["cam", "cameron"],
  ["jon", "jonathan"],
  ["greg", "gregory"],
  ["steve", "steven"],
  ["ed", "edward"],
  ["jim", "james"],
  ["ken", "kenneth"],
  ["pat", "patrick"],
];

// Tries the exact normalized name first, then — only if that fails — swaps
// the first name for its nickname/full-name counterpart and tries again.
// Used only to look up AAV/years, never to change what a player is actually
// called (see the cased-name lookup below, which is deliberately untouched
// by this).
function findSalaryMatch(salaryByKey, teamId, rawName) {
  const exact = salaryByKey.get(`${teamId}|${normName(rawName)}`);
  if (exact) return exact;

  const parts = rawName.trim().split(/\s+/);
  if (parts.length < 2) return undefined;
  const first = parts[0].toLowerCase();
  const rest = parts.slice(1).join(" ");
  for (const [nick, full] of NICKNAME_PAIRS) {
    let altFirst = null;
    if (first === nick) altFirst = full;
    else if (first === full) altFirst = nick;
    if (!altFirst) continue;
    const altName = altFirst.charAt(0).toUpperCase() + altFirst.slice(1) + " " + rest;
    const match = salaryByKey.get(`${teamId}|${normName(altName)}`);
    if (match) return match;
  }
  return undefined;
}

// Smart-enough Title Case for the all-caps xlsx names (used only when no
// salary-CSV match supplies an already-nicely-cased name) — handles
// Mc/Mac and apostrophe/hyphen segments so "MCDAVID" / "O'BRIEN" /
// "ST-LOUIS" don't come out wrong the way a naive title-case would.
function titleCaseName(raw) {
  return raw
    .toLowerCase()
    .split(" ")
    .map((word) =>
      word
        .split(/([-'])/)
        .map((seg) => {
          if (seg === "-" || seg === "'") return seg;
          if (/^mc./.test(seg)) return "Mc" + seg[2].toUpperCase() + seg.slice(3);
          if (/^mac.{2,}/.test(seg)) return "Mac" + (seg[3] ? seg[3].toUpperCase() + seg.slice(4) : "");
          return seg.charAt(0).toUpperCase() + seg.slice(1);
        })
        .join("")
    )
    .join(" ");
}

// Minimal RFC4180-ish parser (quoted fields, embedded commas, "" escapes) —
// verified against both source files that no quoted field spans multiple
// lines (parsed row count already matches wc -l - 1 for both), so a plain
// per-line split is safe; only within-line quote handling is needed.
function parseCsvLine(line) {
  const cells = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      cells.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  return cells;
}

function parseCsvFile(filePath) {
  const lines = fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.length > 0);
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const row = {};
    header.forEach((h, i) => (row[h] = cells[i] !== undefined ? cells[i] : ""));
    return row;
  });
}

// xlsx header -> this app's skater attribute key. Headers already match the
// app's own camelCase keys almost exactly (just capitalized), unlike the
// old Rosters/ CSVs which needed a hand-written per-file mapping.
const SKATER_COLUMN_MAP = {
  Deking: "deking",
  HandEye: "handEye",
  Passing: "passing",
  PuckControl: "puckControl",
  DefAwareness: "defAwareness",
  Faceoffs: "faceoffs",
  ShotBlocking: "shotBlocking",
  StickChecking: "stickChecking",
  Discipline: "discipline",
  OffAwareness: "offAwareness",
  Poise: "poise",
  Acceleration: "acceleration",
  Agility: "agility",
  Balance: "balance",
  Endurance: "endurance",
  Speed: "speed",
  SlapShotAccuracy: "slapShotAccuracy",
  SlapShotPower: "slapShotPower",
  WristShotAccuracy: "wristShotAccuracy",
  WristShotPower: "wristShotPower",
  Aggressiveness: "aggressiveness",
  BodyChecking: "bodyChecking",
  Durability: "durability",
  FightingSkill: "fightingSkill",
  Strength: "strength",
};

// Unlike the old import, this data source has REAL goalie attributes (the
// scraper captured the actual NHL 27 goalie card), not a procedural fake —
// every one of this app's 16 GOALIE_ATTRS has a matching xlsx column.
const GOALIE_COLUMN_MAP = {
  GloveLow: "gloveLow",
  StickLow: "stickLow",
  FiveHole: "fiveHole",
  GloveHigh: "gloveHigh",
  StickHigh: "stickHigh",
  Passing: "passing",
  Speed: "speed",
  Agility: "agility",
  PokeCheck: "pokeCheck",
  Durability: "durability",
  Endurance: "endurance",
  ReboundControl: "reboundControl",
  Vision: "vision",
  Breakaway: "breakaway",
  Angles: "angles",
  Recover: "recover",
};

// Primary position only (first token of a combo like "RW/LW" or "LD/RD") —
// position === "D"/"G" are load-bearing checks all over store.js, so both
// D variants must collapse to plain "D".
const POSITION_ALIASES = { LD: "D", RD: "D" };
function primaryPosition(raw) {
  const token = (raw || "").split("/")[0].trim().toUpperCase();
  return POSITION_ALIASES[token] || token;
}

const CONFIDENCE_MAP = { LOW: "red", MED: "yellow", HIGH: "green", EXACT: "green" };

// PotentialTier is a ceiling ROLE label ("FRANCHISE", "AHL FRINGE G", ...),
// not a star count — this app wants 0.5-5 stars, so every tier is hand-
// mapped to a star value, roughly ordered best-to-worst ceiling. A
// judgment call (no ground truth for "FRANCHISE = 5.0 exactly"), same
// tunable-not-authoritative spirit as every other calibration constant in
// store.js — revisit if trade values/contract asks look off for a tier.
const TIER_TO_STARS = {
  FRANCHISE: 5,
  ELITE: 4.5,
  TOP2D: 4,
  TOP4D: 4,
  TOP6D: 4,
  TOP6F: 4,
  TOP9F: 3.5,
  STARTER: 3.5,
  BOTTOM6F: 3,
  "7THD": 3,
  BACKUP: 2.5,
  AHLTOP2D: 2.5,
  AHLTOP6F: 2.5,
  "AHL STARTER": 2,
  AHLSTARTER: 2,
  FRINGESTARTER: 2,
  "FRINGE STARTER": 2,
  "AHL EXTRA F": 1.5,
  AHLEXTRAF: 1.5,
  "AHL BOTTOM 6 F": 1.5,
  AHLBOTTOM6F: 1.5,
  "AHL BACKUP": 1,
  AHLBACKUP: 1,
  "AHL FRINGE G": 0.5,
  AHLFRINGEG: 0.5,
};
function tierToStars(raw) {
  const key = (raw || "").trim().toUpperCase();
  return TIER_TO_STARS[key] ?? 2.5;
}

async function main() {
  // --- 0. Team lookups: xlsx uses lowercase 3-letter codes ("ana"), the
  // salary/draft-pick CSVs use full "City Name" (matches data.js exactly),
  // and draft-pick "Acquired from X" uses just the nickname ("Blues"). ---
  const abbrToId = new Map(TEAM_DEFS.map((t) => [t.abbr.toLowerCase(), t.id]));
  // The xlsx's scraper used its own 3-letter codes for two teams that don't
  // match data.js's abbr field: "cal" for Calgary (data.js: "cgy") and "was"
  // for Washington (data.js: "wsh"). Found by diffing the xlsx's 32 codes
  // against data.js's — every other team's code matches directly.
  abbrToId.set("cal", TEAM_DEFS.find((t) => t.abbr === "CGY").id);
  abbrToId.set("was", TEAM_DEFS.find((t) => t.abbr === "WSH").id);
  const fullNameToId = new Map(TEAM_DEFS.map((t) => [`${t.city} ${t.name}`, t.id]));
  const nicknameToId = new Map(TEAM_DEFS.map((t) => [t.name, t.id]));

  // --- 1. Salaries CSV: real AAV + years remaining, keyed by team+name. ---
  const salaryRows = parseCsvFile(path.join(DATA_DIR, "all_teams_salaries.csv"));
  const salaryByKey = new Map();
  for (const row of salaryRows) {
    const teamId = fullNameToId.get(row.Team);
    if (!teamId) continue;
    const aavRaw = (row.AAV || "").replace(/[$,]/g, "").trim();
    const aav = aavRaw !== "" ? Number(aavRaw) / 1_000_000 : null;
    const years = Number(row.RemainingYears);
    salaryByKey.set(`${teamId}|${normName(row.Player)}`, {
      aavMillions: Number.isFinite(aav) ? aav : null,
      years: Number.isFinite(years) && years > 0 ? clamp(Math.round(years), 1, 8) : null,
    });
  }
  console.log(`Parsed ${salaryByKey.size} real contracts from all_teams_salaries.csv.`);

  // --- 2. Draft picks CSV: real 2027-2031 ownership. "Traded Away" rows are
  // the inverse duplicate of another team's "Acquired from X" row for the
  // same physical pick (verified: Own+Acquired always sums to exactly
  // 32 teams * 7 rounds = 224 per year, across all 5 years) — skip them. ---
  const draftPickRows = parseCsvFile(path.join(DATA_DIR, "all_teams_draft_picks.csv"));
  const draftPicks = [];
  let skippedPickRows = 0;
  for (const row of draftPickRows) {
    if (row.Status === "Traded Away") continue;
    const currentTeamId = fullNameToId.get(row.Team);
    const seasonNumber = Number(row.Year) - REAL_SEASON_BASE_YEAR;
    const round = Number(row.Round);
    if (!currentTeamId || !Number.isFinite(seasonNumber) || !Number.isFinite(round)) {
      skippedPickRows++;
      continue;
    }
    let originalTeamId = currentTeamId;
    if (row.Status && row.Status.startsWith("Acquired from ")) {
      const nickname = row.Status.slice("Acquired from ".length).trim();
      originalTeamId = nicknameToId.get(nickname);
      if (!originalTeamId) {
        console.warn(`  unrecognized draft-pick source team "${nickname}" — defaulting original to current owner`);
        originalTeamId = currentTeamId;
      }
    }
    draftPicks.push({ seasonNumber, round, originalTeamId, currentTeamId });
  }
  console.log(
    `Parsed ${draftPicks.length} real draft picks across seasons ${Math.min(...draftPicks.map((p) => p.seasonNumber))}-${Math.max(
      ...draftPicks.map((p) => p.seasonNumber)
    )} (skipped ${skippedPickRows} unrecognized rows).`
  );

  // --- 3. Players xlsx: the authoritative roster + real attributes. ---
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.join(DATA_DIR, "NHL_All_Teams_Players.xlsx"));
  const sheet = workbook.getWorksheet("Players");
  const header = sheet.getRow(1).values; // 1-indexed, values[0] is unused (null)
  const colIndex = {};
  header.forEach((h, i) => {
    if (h) colIndex[h] = i;
  });

  const parsedPlayers = [];
  const usedNumbersByTeam = new Map();
  let skippedPlayerRows = 0;

  sheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1) return;
    const v = row.values;
    const teamId = abbrToId.get((v[colIndex.Team] || "").toString().trim().toLowerCase());
    const rawName = (v[colIndex.Name] || "").toString().trim();
    if (!teamId || !rawName) {
      skippedPlayerRows++;
      return;
    }

    const position = primaryPosition(v[colIndex.Position]);
    if (!["C", "LW", "RW", "D", "G"].includes(position)) {
      console.warn(`  skipping ${rawName}: unrecognized position "${v[colIndex.Position]}"`);
      skippedPlayerRows++;
      return;
    }

    const rawOverall = Number(v[colIndex.Overall]);
    const overall = Number.isFinite(rawOverall) ? clamp(Math.round(rawOverall), 40, 99) : 65;
    const rawAge = Number(v[colIndex.Age]);
    const age = Number.isFinite(rawAge) && rawAge > 0 ? Math.round(rawAge) : 25;

    const stars = tierToStars(v[colIndex.PotentialTier]);
    const confidence = CONFIDENCE_MAP[(v[colIndex.PotentialConfidence] || "").toString().trim().toUpperCase()] || "yellow";
    const potential = { stars, confidence };

    const isGoalie = position === "G";
    const columnMap = isGoalie ? GOALIE_COLUMN_MAP : SKATER_COLUMN_MAP;
    const attrList = isGoalie ? GOALIE_ATTRS : SKATER_ATTRS;
    const attributes = {};
    for (const [xlsxCol, attrKey] of Object.entries(columnMap)) {
      const raw = Number(v[colIndex[xlsxCol]]);
      attributes[attrKey] = Number.isFinite(raw) ? clamp(Math.round(raw), 40, 99) : clamp(overall + randInt(-8, 8), 45, 99);
    }
    // Any of this app's attribute keys with no xlsx column at all for this
    // position (shouldn't happen given the maps above cover all 25/16, but
    // stay defensive) falls back the same way.
    for (const attrKey of attrList) {
      if (!(attrKey in attributes)) attributes[attrKey] = clamp(overall + randInt(-8, 8), 45, 99);
    }

    if (!usedNumbersByTeam.has(teamId)) usedNumbersByTeam.set(teamId, { used: new Set(), next: 90 });
    const numState = usedNumbersByTeam.get(teamId);
    let jerseyNumber = Number(v[colIndex.JerseyNumber]);
    if (!jerseyNumber || jerseyNumber < 1 || jerseyNumber > 98 || numState.used.has(jerseyNumber)) {
      while (numState.used.has(numState.next)) numState.next++;
      jerseyNumber = numState.next;
    }
    numState.used.add(jerseyNumber);

    const salaryMatch = findSalaryMatch(salaryByKey, teamId, rawName);

    parsedPlayers.push({
      teamId,
      rawName,
      position,
      jerseyNumber,
      age,
      overall,
      attributes,
      potential,
      isGoalie,
      salaryMatch,
    });
  });

  // Real, nicely-cased name is only available from the salary CSV — build a
  // reverse lookup (team+normalized name -> cased name) for that, since the
  // salary rows themselves were only kept as team/AAV/years above.
  const casedNameByKey = new Map();
  for (const row of salaryRows) {
    const teamId = fullNameToId.get(row.Team);
    if (teamId) casedNameByKey.set(`${teamId}|${normName(row.Player)}`, row.Player);
  }

  let matchedContracts = 0;
  for (const p of parsedPlayers) {
    const cased = casedNameByKey.get(`${p.teamId}|${normName(p.rawName)}`);
    p.name = cased || titleCaseName(p.rawName);

    if (p.salaryMatch && p.salaryMatch.aavMillions != null && p.salaryMatch.years != null) {
      p.capHit = p.salaryMatch.aavMillions;
      p.contractYearsLeft = p.salaryMatch.years;
      matchedContracts++;
    } else {
      const demand = store.computeContractDemand({ age: p.age, overall: p.overall, potential: p.potential });
      p.capHit = demand.aavMillions;
      p.contractYearsLeft = randInt(1, 6);
    }
    delete p.salaryMatch;
    delete p.rawName;
  }

  console.log(
    `Parsed ${parsedPlayers.length} real players across 32 teams (${matchedContracts} matched a real contract; the rest fell back to computed demand). Skipped ${skippedPlayerRows} rows.`
  );

  // --- 4. Sync teams table (idempotent upsert, same as importRealRosters.js) ---
  for (const t of TEAM_DEFS) {
    await pool.query(
      `INSERT INTO teams (id, city, name, abbr, conference, division, is_human_controlled)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         city = EXCLUDED.city, name = EXCLUDED.name, abbr = EXCLUDED.abbr,
         conference = EXCLUDED.conference, division = EXCLUDED.division`,
      [t.id, t.city, t.name, t.abbr, t.conference, t.division, t.isHumanControlled]
    );
  }
  const teamsRes = await pool.query("SELECT id FROM teams");
  const teamIds = teamsRes.rows.map((t) => t.id);
  const teamsForSchedule = TEAM_DEFS.map((t) => ({ id: t.id, isHumanControlled: t.isHumanControlled }));
  console.log(`Synced teams table to ${TEAM_DEFS.length} real NHL franchises.`);

  // --- 5. Wipe every table that depends on the current players/season, FK-safe order ---
  await pool.query("DELETE FROM free_agent_bids");
  await pool.query("DELETE FROM trade_proposals");
  await pool.query("DELETE FROM notifications");
  await pool.query("DELETE FROM games");
  await pool.query("DELETE FROM players");
  await pool.query("DELETE FROM draft_picks");
  await pool.query("DELETE FROM draft_prospects");
  await pool.query("DELETE FROM season_results");
  console.log("Cleared free_agent_bids, trade_proposals, notifications, games, players, draft_picks, draft_prospects, season_results.");

  // --- 6. Insert real players ---
  let nextId = 1;
  for (const p of parsedPlayers) {
    const stats = p.isGoalie
      ? {
          gamesPlayed: 0,
          wins: 0,
          losses: 0,
          otLosses: 0,
          goalsAgainstAverage: 0,
          savePercentage: 0,
          shutouts: 0,
          _goalsAgainstTotal: 0,
          _shotsFacedTotal: 0,
        }
      : { gamesPlayed: 0, goals: 0, assists: 0, points: 0, plusMinus: 0 };

    await pool.query(
      `INSERT INTO players
         (id, team_id, name, position, jersey_number, age, overall, cap_hit,
          contract_years_left, in_game_status, roster_assignment, attributes, potential, stats)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'not_created','MINORS',$10,$11,$12)`,
      [
        nextId,
        p.teamId,
        p.name,
        p.position,
        p.jerseyNumber,
        p.age,
        p.overall,
        p.capHit,
        p.contractYearsLeft,
        JSON.stringify(p.attributes),
        JSON.stringify(p.potential),
        JSON.stringify(stats),
      ]
    );
    nextId++;
  }
  console.log(`Inserted ${parsedPlayers.length} players (ids 1-${nextId - 1}).`);

  // --- 7. Insert real draft-pick ownership ---
  for (const dp of draftPicks) {
    await pool.query(
      `INSERT INTO draft_picks (season_number, round, original_team_id, current_team_id) VALUES ($1,$2,$3,$4)`,
      [dp.seasonNumber, dp.round, dp.originalTeamId, dp.currentTeamId]
    );
  }
  console.log(`Inserted ${draftPicks.length} real draft picks (seasons 1-5).`);

  // --- 8. Sane starting lineup for every team ---
  for (const teamId of teamIds) {
    await store.autoSetLineup(teamId);
  }
  console.log(`Auto-set lineups for all ${teamIds.length} teams.`);

  // --- 9. Reset league_state to the start of the season ---
  const seasonNumber = 1;
  const seasonStartDate = "2026-10-01";
  await pool.query(
    `UPDATE league_state
     SET season_number = $1, league_date = $2, next_game_id = 1, phase = 'regular_season', phase_round = 1, current_pick_index = 0
     WHERE id = 1`,
    [seasonNumber, seasonStartDate]
  );
  console.log(`league_state reset: season ${seasonNumber}, date ${seasonStartDate}, phase regular_season round 1.`);

  // --- 10. Fresh schedule ---
  const generated = generateNhlStyleSchedule(teamsForSchedule, { startDate: seasonStartDate, daysBetweenRounds: 3 });
  let nextGameId = 1;
  for (const g of generated) {
    await pool.query(
      `INSERT INTO games (id, date, home_team_id, away_team_id, status, home_score, away_score, went_to_ot, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [nextGameId, g.date, g.homeTeamId, g.awayTeamId, g.status, g.homeScore, g.awayScore, g.wentToOT, g.source]
    );
    nextGameId++;
  }
  await pool.query("UPDATE league_state SET next_game_id = $1 WHERE id = 1", [nextGameId]);
  console.log(`Generated ${generated.length}-game schedule starting ${seasonStartDate}.`);

  // --- 11. Fresh prospect class for season 1's draft (no real prospect data source yet) ---
  await store.generateRandomDraftClass(seasonNumber);
  console.log(`Generated season ${seasonNumber} prospect class.`);

  console.log("\nDone.");
}

// db.js's pool export is a { query, connect } wrapper around a per-league
// Pool it never exposes for closing (see db.js's poolFor) — no .end() to
// call, so force the exit instead of leaving the process hanging on an
// open connection.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

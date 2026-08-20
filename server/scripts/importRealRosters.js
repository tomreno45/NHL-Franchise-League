// One-time migration: replaces every mock player in the league with real
// NHL rosters imported from CSVs in ../../Rosters, and resets the league to
// the start of the season. Kept around (not deleted after use) as a record
// of how this happened and in case the same CSVs need re-importing later.
//
// CSV format note: every file uses the same 25 NHL26 skater attributes this
// app already tracks (see data.js's ATTRIBUTE_CATEGORIES), but Detroit's
// file has its Potential/Confidence columns in a DIFFERENT position than
// the other 7 files — parsing is header-name-driven specifically because
// of that, never positional.
//
// Goalies: the CSVs don't carry this app's NHL26 goalie attribute set
// (gloveLow/stickLow/etc.) at all — those are generated procedurally
// around each goalie's real OVR, same distribution data.js already uses
// for goalie generation. A handful of depth goalies have no OVR in the
// source data at all ("No data (OVR unavailable)"); those fall back to 65.
//
// Contracts: the CSVs don't include cap hit or contract term either — every
// player gets a starting cap hit from the app's own computeContractDemand
// formula (their current market ask) and a random 1-6 year term, so the
// league's cap economy is internally consistent from day one.
const fs = require("fs");
const path = require("path");
const { pool } = require("../db");
const store = require("../store");
const { GOALIE_ATTRS, teams: TEAM_DEFS } = require("../data");
const { generateNhlStyleSchedule } = require("../scheduleGenerator");

const ROSTERS_DIR = path.join(__dirname, "..", "..", "Rosters");

const FILE_TO_TEAM_ID = {
  "boston_bruins_full_attributes_interpolated.csv": 1,
  "toronto_maple_leafs_full_attributes_interpolated.csv": 2,
  "chicago_blackhawks_full_attributes_interpolated.csv": 3,
  "nashville_predators_full_attributes_interpolated.csv": 4,
  "dallas_stars_full_attributes_interpolated.csv": 5,
  "detroit_red_wings_full_attributes_interpolated.csv": 6,
  "colorado_avalanche_full_attributes_interpolated.csv": 7,
  "vegas_golden_knights_full_attributes_interpolated.csv": 8,
  "anaheim_ducks_full_attributes_interpolated.csv": 9,
  "buffalo_sabres_full_attributes_interpolated.csv": 10,
  "calgary_flames_full_attributes_interpolated.csv": 11,
  "carolina_hurricanes_full_attributes_interpolated.csv": 12,
  "columbus_blue_jackets_full_attributes_interpolated.csv": 13,
  "edmonton_oilers_full_attributes_interpolated.csv": 14,
  "florida_panthers_full_attributes_interpolated.csv": 15,
  "los_angeles_kings_full_attributes_interpolated.csv": 16,
  "minnesota_wild_full_attributes_interpolated.csv": 17,
  "montreal_canadiens_full_attributes_interpolated.csv": 18,
  "new_jersey_devils_full_attributes_interpolated.csv": 19,
  "new_york_islanders_full_attributes_interpolated.csv": 20,
  "new_york_rangers_full_attributes_interpolated.csv": 21,
  "ottawa_senators_full_attributes_interpolated.csv": 22,
  "philadelphia_flyers_full_attributes_interpolated.csv": 23,
  "pittsburgh_penguins_full_attributes_interpolated.csv": 24,
  "san_jose_sharks_full_attributes_interpolated.csv": 25,
  "seattle_kraken_full_attributes_interpolated.csv": 26,
  "st_louis_blues_full_attributes_interpolated.csv": 27,
  "tampa_bay_lightning_full_attributes_interpolated.csv": 28,
  "utah_mammoth_full_attributes_interpolated.csv": 29,
  "vancouver_canucks_full_attributes_interpolated.csv": 30,
  "washington_capitals_full_attributes_interpolated.csv": 31,
  "winnipeg_jets_full_attributes_interpolated.csv": 32,
};

const POSITION_MAP = { C: "C", L: "LW", R: "RW", D: "D", G: "G" };
const CONFIDENCE_MAP = { LOW: "red", MED: "yellow", HIGH: "green", EXACT: "green" };

// CSV column name -> this app's attribute key. Only the 25 leaf attributes
// are read; the 6 category-summary columns (PuckSkills/Defense/Senses/
// Skating/Shooting/Physical) are ignored since the app computes category
// averages itself at read time.
const ATTR_COLUMN_MAP = {
  Deking: "deking",
  HandEye: "handEye",
  Passing: "passing",
  PuckControl: "puckControl",
  DefensiveAwareness: "defAwareness",
  Faceoffs: "faceoffs",
  ShotBlocking: "shotBlocking",
  StickChecking: "stickChecking",
  Discipline: "discipline",
  OffensiveAwareness: "offAwareness",
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

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function parseCsv(filePath) {
  const lines = fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row = {};
    header.forEach((h, i) => (row[h] = cells[i]));
    return row;
  });
}

function buildSkaterAttributes(row) {
  const attributes = {};
  for (const [csvCol, attrKey] of Object.entries(ATTR_COLUMN_MAP)) {
    const raw = row[csvCol];
    attributes[attrKey] = raw && raw.trim() !== "" ? clamp(Math.round(Number(raw)), 40, 99) : 60;
  }
  return attributes;
}

// Same distribution data.js's goalie generation uses: jitter every one of
// the 16 NHL26 goalie attributes around a quality base, then let overall
// fall out as their mean rather than forcing an exact match.
function buildGoalieAttributes(targetOverall) {
  const attributes = {};
  GOALIE_ATTRS.forEach((attr) => {
    attributes[attr] = clamp(Math.round(targetOverall + (Math.random() * 16 - 8)), 45, 99);
  });
  return attributes;
}

function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function buildEmptySkaterStats() {
  return { gamesPlayed: 0, goals: 0, assists: 0, points: 0, plusMinus: 0 };
}
function buildEmptyGoalieStats() {
  return {
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
}

// Brings the `teams` table up to data.js's full 32-team real-NHL alignment:
// corrects conference/division on the original 8 (some were placeholder
// mock-league assignments, not real ones — e.g. Chicago/Nashville/Dallas
// were never actually in the "Eastern"/"Pacific" the mock league gave them)
// and inserts the 24 teams added for this expansion. ids are stable (never
// reassigned) so existing FKs — users.team_id, historical draft_order/
// season_results rows — keep pointing at the right franchise.
async function syncTeamsTable() {
  for (const t of TEAM_DEFS) {
    await pool.query(
      `INSERT INTO teams (id, city, name, abbr, conference, division, is_human_controlled)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         city = EXCLUDED.city,
         name = EXCLUDED.name,
         abbr = EXCLUDED.abbr,
         conference = EXCLUDED.conference,
         division = EXCLUDED.division`,
      [t.id, t.city, t.name, t.abbr, t.conference, t.division, t.isHumanControlled]
    );
  }
  console.log(`Synced teams table to ${TEAM_DEFS.length} real NHL franchises.`);
}

async function main() {
  await syncTeamsTable();

  const teamsRes = await pool.query("SELECT id, abbr, is_human_controlled FROM teams");
  const teamIds = teamsRes.rows.map((t) => t.id);
  const teamsForSchedule = teamsRes.rows.map((t) => ({ id: t.id, isHumanControlled: t.is_human_controlled }));

  // --- 1. Parse every CSV into player rows, not yet assigned DB ids ---
  const parsedPlayers = [];
  for (const [file, teamId] of Object.entries(FILE_TO_TEAM_ID)) {
    const rows = parseCsv(path.join(ROSTERS_DIR, file));
    const usedNumbers = new Set();
    let nextSyntheticNumber = 90;

    for (const row of rows) {
      const csvPos = (row.Position || "").trim();
      const position = POSITION_MAP[csvPos];
      if (!position) {
        console.warn(`  skipping ${row.Player} (${file}): unrecognized position "${csvPos}"`);
        continue;
      }

      // Missing OVR shows up as either an empty cell or a literal "--" —
      // both fall back to 65 (replacement-level depth guy with no real rating).
      const rawOvr = row.OVR && row.OVR.trim() !== "" ? Number(row.OVR) : NaN;
      const overall = Number.isFinite(rawOvr) ? clamp(Math.round(rawOvr), 40, 99) : 65;

      const age = Number.isFinite(Number(row.Age)) && row.Age ? Number(row.Age) : 25;
      const rawStars = Number(row.Potential);
      const stars = Number.isFinite(rawStars) ? clamp(Math.round(rawStars * 2) / 2, 0.5, 5) : 3;
      const confidence = CONFIDENCE_MAP[(row.Confidence || "").trim()] || "yellow";

      let jerseyNumber = Number(row.Number);
      if (!jerseyNumber || jerseyNumber < 1 || jerseyNumber > 98 || usedNumbers.has(jerseyNumber)) {
        while (usedNumbers.has(nextSyntheticNumber)) nextSyntheticNumber++;
        jerseyNumber = nextSyntheticNumber;
      }
      usedNumbers.add(jerseyNumber);

      const isGoalie = position === "G";
      const attributes = isGoalie ? buildGoalieAttributes(overall) : buildSkaterAttributes(row);
      const potential = { stars, confidence };

      const demand = store.computeContractDemand({ age, overall, potential });

      parsedPlayers.push({
        teamId,
        name: row.Player,
        position,
        jerseyNumber,
        age,
        overall,
        capHit: demand.aavMillions,
        contractYearsLeft: randInt(1, 6),
        inGameStatus: "not_created",
        attributes,
        potential,
        stats: isGoalie ? buildEmptyGoalieStats() : buildEmptySkaterStats(),
      });
    }
  }

  console.log(`Parsed ${parsedPlayers.length} real players across ${Object.keys(FILE_TO_TEAM_ID).length} teams.`);

  // --- 2. Wipe every table that depends on the current players/season, in FK-safe order ---
  await pool.query("DELETE FROM free_agent_bids");
  await pool.query("DELETE FROM trade_proposals");
  await pool.query("DELETE FROM notifications");
  await pool.query("DELETE FROM games");
  await pool.query("DELETE FROM players");
  await pool.query("DELETE FROM draft_picks");
  await pool.query("DELETE FROM draft_prospects");
  await pool.query("DELETE FROM season_results");
  console.log("Cleared free_agent_bids, trade_proposals, notifications, games, players, draft_picks, draft_prospects, season_results.");

  // --- 3. Insert the real players with fresh sequential ids ---
  let nextId = 1;
  for (const p of parsedPlayers) {
    await pool.query(
      `INSERT INTO players
         (id, team_id, name, position, jersey_number, age, overall, cap_hit,
          contract_years_left, in_game_status, roster_assignment, attributes, potential, stats)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'MINORS',$11,$12,$13)`,
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
        p.inGameStatus,
        JSON.stringify(p.attributes),
        JSON.stringify(p.potential),
        JSON.stringify(p.stats),
      ]
    );
    nextId++;
  }
  console.log(`Inserted ${parsedPlayers.length} players (ids 1-${nextId - 1}).`);

  // --- 4. Give every team a sane starting lineup ---
  for (const teamId of teamIds) {
    await store.autoSetLineup(teamId);
  }
  console.log(`Auto-set lineups for all ${teamIds.length} teams.`);

  // --- 5. Reset league_state to the start of the season ---
  const stateRes = await pool.query("SELECT season_number FROM league_state WHERE id = 1");
  const seasonNumber = stateRes.rows[0].season_number;
  const seasonStartDate = "2026-10-01";

  await pool.query(
    `UPDATE league_state
     SET league_date = $1, next_game_id = 1, phase = 'regular_season', phase_round = 1, current_pick_index = 0
     WHERE id = 1`,
    [seasonStartDate]
  );
  console.log(`league_state reset: season ${seasonNumber}, date ${seasonStartDate}, phase regular_season round 1.`);

  // --- 6. Fresh schedule ---
  const generated = generateNhlStyleSchedule(teamsForSchedule, {
    startDate: seasonStartDate,
    daysBetweenRounds: 3,
  });
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

  // --- 7. Fresh draft picks + prospect class for this season ---
  await store.ensureDraftPicksThroughWindow(seasonNumber);
  await store.generateRandomDraftClass(seasonNumber);
  console.log(`Regenerated draft picks + prospect class for season ${seasonNumber}.`);

  await pool.end();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

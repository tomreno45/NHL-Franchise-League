// Imports the "2027Draftees" and "FreeAgents" rows of Roster Database/NHL_All_Teams_Players.xlsx
// into the OG HFL league WITHOUT touching its existing 32 team rosters:
//   - 2027Draftees -> draft_prospects for the league's current season (replaces that season's
//     generated class; the old class is first written to db_backups/ as JSON so it can be restored)
//   - FreeAgents   -> new `players` rows with team_id = NULL (the free-agent pool)
//
//   LEAGUE=og_hfl node scripts/importDraftClassAndFreeAgents.js            (dry run, writes nothing)
//   LEAGUE=og_hfl node scripts/importDraftClassAndFreeAgents.js --apply    (writes)
//
// Refuses to run against anything but a localhost database unless ALLOW_REMOTE_OG_HFL is set to the
// exact host:port of the database (e.g. ALLOW_REMOTE_OG_HFL=host.proxy.rlwy.net:36254), so a hosted
// (Railway) database can never be hit by accident.
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const { pool } = require("../db");
const { SKATER_ATTRS, GOALIE_ATTRS, normalizePlayerType, X_FACTOR_SKATER_ABILITIES, X_FACTOR_GOALIE_ABILITIES } = require("../data");

const APPLY = process.argv.includes("--apply");
// --update-existing (alias --xfactors-only): just set x_factors, player_type and jersey_number on the draft prospects already imported (matched by name), nothing else.
const XF_ONLY = process.argv.includes("--xfactors-only") || process.argv.includes("--update-existing");
const XLSX = path.join(__dirname, "..", "..", "Roster Database", "NHL_All_Teams_Players.xlsx");

// ---- safety: local database only
const url = process.env.DATABASE_URL_OG_HFL || "";
const isLocal = /@(localhost|127\.0\.0\.1)(:|\/)/.test(url);
const remoteOk = !!process.env.ALLOW_REMOTE_OG_HFL && url.includes("@" + process.env.ALLOW_REMOTE_OG_HFL + "/");
if (process.env.LEAGUE !== "og_hfl" || !(isLocal || remoteOk) || !/\/hockey_franchise_og_hfl$/.test(url)) {
  console.error("Refusing to run: LEAGUE must be og_hfl and DATABASE_URL_OG_HFL must be the og_hfl database on localhost (or the host named in ALLOW_REMOTE_OG_HFL).");
  process.exit(1);
}

const SKATER_COLUMN_MAP = {
  Deking: "deking", HandEye: "handEye", Passing: "passing", PuckControl: "puckControl", DefAwareness: "defAwareness",
  Faceoffs: "faceoffs", ShotBlocking: "shotBlocking", StickChecking: "stickChecking", Discipline: "discipline",
  OffAwareness: "offAwareness", Poise: "poise", Acceleration: "acceleration", Agility: "agility", Balance: "balance",
  Endurance: "endurance", Speed: "speed", SlapShotAccuracy: "slapShotAccuracy", SlapShotPower: "slapShotPower",
  WristShotAccuracy: "wristShotAccuracy", WristShotPower: "wristShotPower", Aggressiveness: "aggressiveness",
  BodyChecking: "bodyChecking", Durability: "durability", FightingSkill: "fightingSkill", Strength: "strength",
};
const GOALIE_COLUMN_MAP = {
  GloveLow: "gloveLow", StickLow: "stickLow", FiveHole: "fiveHole", GloveHigh: "gloveHigh", StickHigh: "stickHigh",
  Passing: "passing", Speed: "speed", Agility: "agility", PokeCheck: "pokeCheck", Durability: "durability",
  Endurance: "endurance", ReboundControl: "reboundControl", Vision: "vision", Breakaway: "breakaway",
  Angles: "angles", Recover: "recover",
};
// Same tier -> stars and confidence mappings as importOgHflRosters.js
const CONFIDENCE_MAP = { LOW: "red", MED: "yellow", HIGH: "green", EXACT: "green" };
const TIER_TO_STARS = {
  FRANCHISE: 5, ELITE: 4.5, TOP2D: 4, TOP4D: 4, TOP6D: 4, TOP6F: 4, TOP9F: 3.5, STARTER: 3.5, BOTTOM6F: 3, "7THD": 3,
  BACKUP: 2.5, AHLTOP2D: 2.5, AHLTOP6F: 2.5, "AHL STARTER": 2, AHLSTARTER: 2, FRINGESTARTER: 2, "FRINGE STARTER": 2,
  "AHL EXTRA F": 1.5, AHLEXTRAF: 1.5, "AHL BOTTOM 6 F": 1.5, AHLBOTTOM6F: 1.5, "AHL BACKUP": 1, AHLBACKUP: 1,
  "AHL FRINGE G": 0.5, AHLFRINGEG: 0.5,
};
const TIER_KEY = { Specialist: "specialist", "All-Star": "all_star", Elite: "elite" };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const heightInches = (raw) => { const m = String(raw || "").match(/(\d+)'\s*(\d+)/); return m ? +m[1] * 12 + +m[2] : null; };
const primaryPos = (raw) => { const t = String(raw || "").split("/")[0].trim().toUpperCase(); return t === "LD" || t === "RD" ? "D" : t; };
function titleCaseName(raw) {
  return raw.toLowerCase().split(" ").map((word) => word.split(/([-'])/).map((seg) => {
    if (seg === "-" || seg === "'") return seg;
    if (/^mc./.test(seg)) return "Mc" + seg[2].toUpperCase() + seg.slice(3);
    if (/^mac.{2,}/.test(seg)) return "Mac" + (seg[3] ? seg[3].toUpperCase() + seg.slice(4) : "");
    return seg.charAt(0).toUpperCase() + seg.slice(1);
  }).join("")).join(" ");
}
function gaussianNoise(sd) {
  const u1 = Math.max(Math.random(), 1e-9), u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * sd;
}

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX);
  const sheet = wb.getWorksheet("Players");
  const col = {};
  sheet.getRow(1).values.forEach((h, i) => { if (h) col[h] = i; });
  const cell = (v, k) => { const x = v[col[k]]; return x && typeof x === "object" && "result" in x ? x.result : x; };

  const draftees = [], freeAgents = [], skippedXF = [];
  sheet.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const v = row.values;
    const team = String(cell(v, "Team") || "");
    if (team !== "2027Draftees" && team !== "FreeAgents") return;
    const position = primaryPos(cell(v, "Position"));
    const isG = position === "G";
    const overall = clamp(Math.round(Number(cell(v, "Overall"))), 30, 99);
    const attributes = {};
    for (const [xl, key] of Object.entries(isG ? GOALIE_COLUMN_MAP : SKATER_COLUMN_MAP)) {
      const raw = Number(cell(v, xl));
      if (!Number.isFinite(raw)) throw new Error(`${cell(v, "Name")}: missing ${xl}`);
      attributes[key] = clamp(Math.round(raw), 30, 99);
    }
    for (const key of isG ? GOALIE_ATTRS : SKATER_ATTRS) if (!(key in attributes)) throw new Error(`${cell(v, "Name")}: attribute ${key} unmapped`);
    const tier = String(cell(v, "PotentialTier") || "").trim().toUpperCase();
    if (!(tier in TIER_TO_STARS)) throw new Error(`${cell(v, "Name")}: unknown potential tier "${tier}"`);
    const potential = {
      stars: TIER_TO_STARS[tier],
      confidence: CONFIDENCE_MAP[String(cell(v, "PotentialConfidence") || "").trim().toUpperCase()] || "yellow",
    };
    const name = titleCaseName(String(cell(v, "Name")).trim());
    const rec = {
      name, position, overall, attributes, potential,
      age: Math.round(Number(cell(v, "Age"))) || 18,
      nationality: cell(v, "Nationality") || "Canada",
      heightInches: heightInches(cell(v, "Height")) || (position === "D" || isG ? 73 : 71),
      weightLbs: Math.round(Number(cell(v, "Weight"))) || 190,
      jersey: clamp(Math.round(Number(cell(v, "JerseyNumber"))) || 90, 1, 98),
      playerType: normalizePlayerType(cell(v, "PlayerType")),
    };
    const allowed = isG ? X_FACTOR_GOALIE_ABILITIES : X_FACTOR_SKATER_ABILITIES;
    rec.xFactors = [];
    for (const i of [1, 2, 3]) {
      const ability = cell(v, `XFactor${i}`), t = TIER_KEY[cell(v, `XFactor${i}Tier`)];
      if (!ability) continue;
      if (allowed.includes(ability) && t) rec.xFactors.push({ ability, tier: t });
      else skippedXF.push(`${name}: ${ability} (${cell(v, `XFactor${i}Tier`)})`);
    }
    (team === "2027Draftees" ? draftees : freeAgents).push(rec);
  });

  const { rows: st } = await pool.query("SELECT season_number FROM league_state WHERE id = 1");
  const season = st[0].season_number;
  const { rows: cur } = await pool.query("SELECT count(*)::int n FROM draft_prospects WHERE season_number = $1", [season]);
  const { rows: fa0 } = await pool.query("SELECT count(*)::int n FROM players WHERE team_id IS NULL");
  const { rows: dupes } = await pool.query("SELECT name FROM players WHERE team_id IS NULL");
  const stats = (p) => p === "G"
    ? { gamesPlayed: 0, wins: 0, losses: 0, otLosses: 0, goalsAgainstAverage: 0, savePercentage: 0, shutouts: 0, _goalsAgainstTotal: 0, _shotsFacedTotal: 0 }
    : { gamesPlayed: 0, goals: 0, assists: 0, points: 0, plusMinus: 0 };

  console.log(`League season ${season}. Draft class now: ${cur[0].n} prospects. Free-agent pool now: ${fa0[0].n}.`);
  console.log(`To import: ${draftees.length} draftees, ${freeAgents.length} free agents.`);
  console.log("Draftee positions:", JSON.stringify(draftees.reduce((a, d) => ((a[d.position] = (a[d.position] || 0) + 1), a), {})));
  console.log("Draftees with X-Factors:", draftees.filter((f) => f.xFactors.length).length, "| free agents with X-Factors:", freeAgents.filter((f) => f.xFactors.length).length, "| skipped (not in the app's X-Factor list):", skippedXF);
  console.log("Sample draftee:", JSON.stringify(draftees[0]).slice(0, 300));
  if (XF_ONLY) {
    await pool.query("ALTER TABLE draft_prospects ADD COLUMN IF NOT EXISTS x_factors JSONB NOT NULL DEFAULT '[]'");
    await pool.query("ALTER TABLE draft_prospects ADD COLUMN IF NOT EXISTS player_type TEXT");
    await pool.query("ALTER TABLE draft_prospects ADD COLUMN IF NOT EXISTS jersey_number INTEGER");
    let set = 0, missing = [];
    for (const p of draftees) {
      if (!APPLY) { set++; continue; }
      const r = await pool.query("UPDATE draft_prospects SET x_factors = $1, player_type = $2, jersey_number = $3 WHERE season_number = $4 AND name = $5", [JSON.stringify(p.xFactors), p.playerType, p.jersey, season, p.name]);
      if (r.rowCount === 1) set++; else missing.push(p.name);
    }
    console.log(APPLY ? `Set X-Factors and player type on ${set} prospects.` : `DRY RUN: would update ${set} prospects.`, missing.length ? "NOT FOUND: " + missing : "");
    process.exit(0);
  }
  if (!APPLY) { console.log("DRY RUN - nothing written. Re-run with --apply."); await pool.query("SELECT 1"); process.exit(0); }
  if (dupes.length) throw new Error("Free-agent pool is not empty; refusing to add a second batch.");

  // rank the class with the app's own formula (overall + 6*stars, plus its scouting noise)
  const ranked = draftees
    .map((p) => ({ ...p, _s: p.overall + p.potential.stars * 6 + gaussianNoise(9) }))
    .sort((a, b) => b._s - a._s);

  // same additive migrations as server/schema.sql (a no-op where they already exist)
  for (const col of ["x_factors JSONB NOT NULL DEFAULT '[]'", "height_inches INTEGER", "weight_lbs INTEGER", "player_type TEXT"]) {
    await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS ${col}`);
  }
  await pool.query("ALTER TABLE draft_prospects ADD COLUMN IF NOT EXISTS x_factors JSONB NOT NULL DEFAULT '[]'");
  await pool.query("ALTER TABLE draft_prospects ADD COLUMN IF NOT EXISTS player_type TEXT");
    await pool.query("ALTER TABLE draft_prospects ADD COLUMN IF NOT EXISTS jersey_number INTEGER");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const old = await client.query("SELECT * FROM draft_prospects WHERE season_number = $1 ORDER BY prospect_rank", [season]);
    const backupDir = path.join(__dirname, "..", "..", "db_backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const backupFile = path.join(backupDir, `og_hfl_draft_prospects_season${season}_before_import_${Date.now()}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(old.rows, null, 1));
    console.log(`Backed up ${old.rows.length} existing prospects to ${backupFile}`);

    await client.query("DELETE FROM draft_prospects WHERE season_number = $1", [season]);
    let rank = 1;
    for (const p of ranked) {
      await client.query(
        `INSERT INTO draft_prospects (season_number, name, position, nationality, height_inches, weight_lbs, age, overall, attributes, potential, prospect_rank, source, x_factors, player_type, jersey_number)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'imported',$12,$13,$14)`,
        [season, p.name, p.position, p.nationality, p.heightInches, p.weightLbs, p.age, p.overall,
         JSON.stringify(p.attributes), JSON.stringify(p.potential), rank++, JSON.stringify(p.xFactors), p.playerType, p.jersey]
      );
    }
    const idRes = await client.query("SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM players");
    let nextId = idRes.rows[0].next_id;
    const firstId = nextId;
    for (const p of freeAgents) {
      await client.query(
        `INSERT INTO players
           (id, team_id, name, position, jersey_number, age, overall, cap_hit, contract_years_left, in_game_status,
            roster_assignment, attributes, potential, stats, rights_only, height_inches, weight_lbs, player_type, nationality, x_factors)
         VALUES ($1,NULL,$2,$3,$4,$5,$6,0,0,'not_created','MINORS',$7,$8,$9,false,$10,$11,$12,$13,$14)`,
        [nextId++, p.name, p.position, p.jersey, p.age, p.overall, JSON.stringify(p.attributes), JSON.stringify(p.potential),
         JSON.stringify(stats(p.position)), p.heightInches, p.weightLbs, p.playerType, p.nationality, JSON.stringify(p.xFactors)]
      );
    }
    await client.query("COMMIT");
    console.log(`Inserted ${ranked.length} draft prospects (season ${season}) and ${freeAgents.length} free agents (player ids ${firstId}-${nextId - 1}).`);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });

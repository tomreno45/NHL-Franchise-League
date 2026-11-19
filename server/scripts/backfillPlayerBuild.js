// Backfills players.height_inches / weight_lbs / player_type / x_factors (see schema.sql)
// for an existing OG HFL database from the same roster spreadsheet it was
// imported from, so X-Factor progression can weight by build and archetype
// (see data.js's X_FACTOR_GUIDELINES). importOgHflRosters.js now writes these
// itself on a fresh import — this exists only for databases imported before
// that.
//
// How rows are matched: the importer inserts players with ids 1..N in
// spreadsheet row order (it skips rows with an unknown team/blank name/
// unrecognized position — none in the current file), so player id i is data
// row i + 1. Rather than trust that blindly, every row is checked against its
// player before anything is written — position group must match for every
// single row (it can't change over time) and names must match for all but a
// handful (a few were hand-corrected after import) — and the whole run aborts
// with no writes if the check fails, so a database that drifted from the
// file can't get someone else's measurements.
//
// Only fills a value in where it's currently NULL, so it's safe to re-run.
// Rookies drafted after the import (ids past the spreadsheet's last row) are
// left alone — their height/weight comes from their draft prospect instead.
//
// X-Factors are likewise only filled in where the player has none yet, so a GM's own edits
// are never overwritten. Only the original team rows (everything before the appended
// 2027Draftees / FreeAgents rows) are used; those players are handled by their own import.
//
// Usage: LEAGUE=og_hfl node scripts/backfillPlayerBuild.js [--apply]   (without --apply: dry run)
// To target a hosted database also set ALLOW_REMOTE_OG_HFL=host:port (the og_hfl db only).
const path = require("path");
const ExcelJS = require("exceljs");
const { pool } = require("../db");
const { normalizePlayerType, X_FACTOR_SKATER_ABILITIES, X_FACTOR_GOALIE_ABILITIES } = require("../data");

const APPLY = process.argv.includes("--apply");
const TIER_KEY = { Specialist: "specialist", "All-Star": "all_star", Elite: "elite" };
const url = process.env.DATABASE_URL_OG_HFL || "";
const isLocal = /@(localhost|127\.0\.0\.1)(:|\/)/.test(url);
const remoteOk = !!process.env.ALLOW_REMOTE_OG_HFL && url.includes("@" + process.env.ALLOW_REMOTE_OG_HFL + "/");
if (process.env.LEAGUE !== "og_hfl" || !(isLocal || remoteOk) || !/\/hockey_franchise_og_hfl$/.test(url)) {
  console.error("Refusing to run: LEAGUE must be og_hfl and DATABASE_URL_OG_HFL must be the og_hfl database on localhost (or the host named in ALLOW_REMOTE_OG_HFL).");
  process.exit(1);
}

const SOURCE = path.join(__dirname, "..", "..", "Roster Database", "NHL_All_Teams_Players.xlsx");
const MAX_NAME_MISMATCH_RATE = 0.05;

const posGroup = (pos) => (/G/.test(pos) ? "G" : /D/.test(pos) ? "D" : "F");
const normName = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z]/g, "")
    .toUpperCase();

function heightInches(raw) {
  const m = String(raw || "").match(/(\d+)'\s*(\d+)/);
  return m ? Number(m[1]) * 12 + Number(m[2]) : null;
}

async function main() {
  if (!process.env.LEAGUE) throw new Error("Set LEAGUE=og_hfl (the only league whose source has this data)");

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(SOURCE);
  const sheet = wb.getWorksheet("Players");
  const header = sheet.getRow(1).values;
  const col = {};
  header.forEach((h, i) => {
    if (h) col[h] = i;
  });

  const source = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1) return;
    const v = row.values;
    if (v[col.Team] === "2027Draftees" || v[col.Team] === "FreeAgents") return;
    const isG = /G/.test(String(v[col.Position] || ""));
    const allowed = isG ? X_FACTOR_GOALIE_ABILITIES : X_FACTOR_SKATER_ABILITIES;
    const xFactors = [];
    for (const i of [1, 2, 3]) {
      const ability = v[col[`XFactor${i}`]], t = TIER_KEY[v[col[`XFactor${i}Tier`]]];
      if (allowed.includes(ability) && t) xFactors.push({ ability, tier: t });
    }
    source.push({
      xFactors,
      name: v[col.Name],
      posGroup: posGroup(String(v[col.Position] || "")),
      heightInches: heightInches(v[col.Height]),
      weightLbs: Number(v[col.Weight]) > 0 ? Math.round(Number(v[col.Weight])) : null,
      playerType: normalizePlayerType(v[col.PlayerType]),
    });
  });

  const { rows: players } = await pool.query(
    "SELECT id, name, position, height_inches, weight_lbs, player_type, x_factors FROM players WHERE id <= $1 ORDER BY id",
    [source.length]
  );
  if (players.length !== source.length) {
    throw new Error(`Expected players 1-${source.length} but found ${players.length} — not aligned with the source file, aborting.`);
  }

  let positionMismatches = 0;
  const nameMismatches = [];
  players.forEach((p, i) => {
    const s = source[i];
    if (posGroup(p.position) !== s.posGroup) positionMismatches++;
    if (normName(p.name) !== normName(s.name)) nameMismatches.push(`${p.name} (db) vs ${s.name} (file)`);
  });
  console.log(
    `Alignment check: ${positionMismatches} position mismatches, ${nameMismatches.length}/${players.length} name mismatches.`
  );
  if (positionMismatches > 0 || nameMismatches.length / players.length > MAX_NAME_MISMATCH_RATE) {
    console.log("Sample mismatches:", nameMismatches.slice(0, 10));
    throw new Error("Rows don't line up with the source file closely enough — aborting without writing anything.");
  }

  let updated = 0, xfSet = 0;
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const s = source[i];
    if (s.xFactors.length && !(p.x_factors || []).length) {
      xfSet++;
      if (APPLY) await pool.query("UPDATE players SET x_factors = $1 WHERE id = $2", [JSON.stringify(s.xFactors), p.id]);
    }
    if (!APPLY) {
      if (p.height_inches == null || p.weight_lbs == null || p.player_type == null) updated++;
      continue;
    }
    const { rowCount } = await pool.query(
      `UPDATE players SET
         height_inches = COALESCE(height_inches, $1),
         weight_lbs = COALESCE(weight_lbs, $2),
         player_type = COALESCE(player_type, $3)
       WHERE id = $4 AND (height_inches IS NULL OR weight_lbs IS NULL OR player_type IS NULL)`,
      [s.heightInches, s.weightLbs, s.playerType, p.id]
    );
    updated += rowCount;
  }
  console.log(`[${process.env.LEAGUE}] ${APPLY ? "filled" : "DRY RUN - would fill"} build/type for ${updated} player(s) and X-Factors for ${xfSet} player(s).`);
  if (nameMismatches.length > 0) {
    console.log("Name mismatches tolerated (hand-corrected names, still matched by position + row order):");
    nameMismatches.forEach((m) => console.log(`  ${m}`));
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });

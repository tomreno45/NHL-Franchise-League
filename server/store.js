const bcrypt = require("bcryptjs");
const { pool, withTransaction } = require("./db");
const { generateNhlStyleSchedule } = require("./scheduleGenerator");
const {
  SKATER_ATTRS,
  ATTRIBUTE_CATEGORIES,
  GOALIE_ATTRS,
  GOALIE_ATTRIBUTE_CATEGORIES,
  generatePotential,
  firstNames,
  lastNames,
} = require("./data");

function categoryAverage(attributes, categoryKeys) {
  return mean(categoryKeys.map((key) => attributes[key]));
}

function invertCategoryMap(categories) {
  const map = {};
  Object.entries(categories).forEach(([category, attrs]) => {
    attrs.forEach((attr) => {
      map[attr] = category;
    });
  });
  return map;
}

const SKATER_ATTR_CATEGORY = invertCategoryMap(ATTRIBUTE_CATEGORIES);
const GOALIE_ATTR_CATEGORY = invertCategoryMap(GOALIE_ATTRIBUTE_CATEGORIES);

function notFound(message) {
  const err = new Error(message);
  err.status = 404;
  return err;
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mean(values) {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function randInRange(min, max) {
  return min + Math.random() * (max - min);
}

function shuffled(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// --- row <-> JS object mapping ---

function mapTeamRow(row) {
  return {
    id: row.id,
    city: row.city,
    name: row.name,
    abbr: row.abbr,
    conference: row.conference,
    division: row.division,
    isHumanControlled: row.is_human_controlled,
  };
}

// Potential's confidence color is scouted once at creation and stored as-is;
// the age-27+ "white, growth mostly plateaued" rule is applied here at read
// time so it always reflects the player's *current* age, not their age when
// the row was written.
function resolvePotential(potential, age) {
  return { stars: potential.stars, confidence: age >= 27 ? "white" : potential.confidence };
}

// Trade value (1-20, shown only as a bar — never a raw number) is a pure
// function of overall/age/potential, all already stored, so it's computed
// fresh on every read rather than persisted: it can never go stale.

// Anchors ~75 OVR ("replacement level") near the bottom of the scale.
// Recalibrated so the high plateau (~20) needs a genuinely elite ~95+ OVR to
// reach on production alone — a very good-but-not-elite 90 OVR should sit
// clearly below max, leaving the top of the scale for true stars (and for
// young players whose *projected* ceiling gets there — see growthValueComponent).
function overallValueComponent(overall) {
  const excess = overall - 75;
  if (excess <= 0) return Math.max(0.5, 3 + excess * 0.15);
  return 3 + excess * 0.5 + excess * excess * 0.02;
}

// Aging costs value, but a genuine star is discounted far less than a
// replacement-level player at the same age — teams pay for production, not
// birthdays, so "old" only tanks value when there's little production to pay for.
function ageDiscount(age, overall) {
  let penalty = 0;
  if (age > 27) penalty += (age - 27) * 0.7;
  if (age > 32) penalty += (age - 32) * 1.0;
  const starProtection = clamp((overall - 78) / 15, 0, 1);
  return penalty * (1 - starProtection * 0.85);
}

// Development-driven value (both remaining ceiling room and pure youth/cost
// control) is concentrated in ages 18-23 — "most of the growth happens
// there" — with only a reduced allowance for 24-26 ("only some after that")
// and none from 27 on, consistent with potential itself going gray at 27.
// Continuous within 18-23 too, not a flat step: two players with the same
// overall/potential but different ages inside that window should NOT tie —
// the younger one has strictly more runway left and should score higher.
function growthWindow(age) {
  if (age <= 18) return 1;
  if (age <= 23) return 1 - (age - 18) * 0.05; // 18 -> 1.0, 23 -> 0.75
  if (age <= 25) return 0.75 - (age - 23) * 0.2; // 23 -> 0.75, 25 -> 0.35
  if (age <= 27) return Math.max(0, 0.35 - (age - 25) * 0.175); // 25 -> 0.35, 27 -> 0
  return 0;
}

// Upside: how much ceiling remains above current overall, weighted by how
// much to trust that ceiling (a green prospect's room to grow is worth more
// than a red one's boom-or-bust upside) and by how much development window
// is left. A player with little room left AND a low current overall —
// replacement level with nowhere to go — is exactly the case this naturally
// drives to near-zero without a special case for it.
const CONFIDENCE_TRUST = { green: 1, yellow: 0.7, red: 0.4, white: 0.25 };

function growthValueComponent(overall, potential, age) {
  const impliedCeiling = (potential.stars / 5) * 99;
  const room = Math.max(0, impliedCeiling - overall);
  const trust = CONFIDENCE_TRUST[potential.confidence] ?? 0.5;
  return room * 0.55 * trust * growthWindow(age);
}

// Separate from projected ceiling: a young player carries trade value just
// from having years of cost-controlled development ahead, the way a real
// prospect or early-career player does even before their ceiling is proven.
// Scaled by the same growth window so it fades on the same 18-23 -> 27 curve.
function youthBonus(age) {
  return 3 * growthWindow(age);
}

// A player whose cap hit sits well above what they'd command on a fresh
// deal is a real trade drag — the acquiring team inherits dead money
// relative to production, on top of however many years they're stuck with
// it. Only bites for older players (>28): a young player on a rich deal is
// still expected to grow into it, so the same cap hit isn't a red flag yet.
function contractBurdenAgeFactor(age) {
  return clamp((age - 28) / 5, 0, 1); // 28 -> 0, 33+ -> full weight
}

function contractBurdenPenalty(player) {
  const ageFactor = contractBurdenAgeFactor(player.age);
  if (ageFactor <= 0) return 0;
  const overpay = player.capHit - player.contractDemand.aavMillions;
  if (overpay <= 0) return 0;
  // Longer remaining term means the acquiring team is stuck with the dead
  // money longer, so the same overpay hurts more; a contract about to
  // expire is barely a burden at all.
  const termFactor = clamp(player.contractYearsLeft / 4, 0, 1);
  return overpay * 0.6 * ageFactor * termFactor;
}

function computeTradeValue(player) {
  const raw =
    overallValueComponent(player.overall) -
    ageDiscount(player.age, player.overall) +
    growthValueComponent(player.overall, player.potential, player.age) +
    youthBonus(player.age) -
    contractBurdenPenalty(player);
  return clamp(Math.round(raw), 1, 20);
}

// Contract demand (asking AAV + years for a new deal) is, like trade value,
// a pure function of already-stored fields — computed fresh on every read,
// never persisted, so it can't go stale as overall/age/potential change.

// Base asking AAV by current overall. Anchored to three data points: <75
// OVR asks the league minimum ($0.925M), 90 OVR asks $10M, and a truly
// elite ~97 OVR asks ~$16M ("15+"). Quadratic above the floor so stars get
// paid disproportionately more, matching how real cap hits cluster — most
// of the league near the floor, a handful of players eating $10M+.
function baseSalaryDemand(overall) {
  if (overall <= 75) return 0.925;
  const x = overall - 75;
  return 0.925 + 0.4331 * x + 0.01146 * x * x;
}

// How strongly a player is still in their "ask for more than I'm worth"
// years — continuous, not a hard cutoff (a flat step here produced an
// unwanted tie between similarly-aged young players in the trade value
// formula earlier; same fix applies here). Full strength through 23,
// fading out by 27.
function youthPremiumFactor(age) {
  if (age <= 23) return 1;
  if (age <= 27) return 1 - (age - 23) * 0.25;
  return 0;
}

// Only genuine upside earns a premium — a replacement-level prospect with
// modest potential doesn't get to demand star money just for being young.
function potentialFactor(stars) {
  return clamp((stars - 2.5) / 2.5, 0, 1);
}

// Years a player is asking for. Young players want term to lock in before
// their next (likely bigger) contract; players 34+ only want 1-2 years —
// nobody signs a long deal with a guy about to decline further. Continuous
// through the middle years, hard override at the top end since "1 or 2
// years" was given as an explicit, not-just-directional, rule.
function baseContractYears(age) {
  if (age <= 23) return 6;
  if (age <= 30) return 6 - (age - 23) * 0.4; // 6 -> 3.2
  if (age <= 33) return Math.max(1.5, 3.2 - (age - 30) * 0.5); // 3.2 -> 1.7
  return 1.5;
}

// A prospect's ceiling only earns them term/money ahead of schedule if
// they're actually likely to get there — a flashy 5-star red-confidence
// project asks like a real 5-star only once they've proven it out.
const HIGH_POTENTIAL_STARS = 4;

function computeContractDemand(player) {
  const isHighPotential = player.potential.stars >= HIGH_POTENTIAL_STARS;
  const isYoung = player.age < 25;
  const premiumStrength = youthPremiumFactor(player.age) * potentialFactor(player.potential.stars);

  // A young, genuinely high-potential player asks based on where they're
  // headed, not just where they are today — blend current overall toward
  // their projected ceiling (same ceiling formula trade value uses),
  // weighted by how much to trust that ceiling actually hits.
  let effectiveOverall = player.overall;
  if (isYoung && isHighPotential) {
    const impliedCeiling = (player.potential.stars / 5) * 99;
    const trust = CONFIDENCE_TRUST[player.potential.confidence] ?? 0.5;
    effectiveOverall = player.overall + (impliedCeiling - player.overall) * trust;
  }

  let salary = baseSalaryDemand(effectiveOverall) * (1 + premiumStrength * 0.35);
  // Nearest $0.025M — coarser $0.05M rounding was snapping the exact 0.925
  // league-minimum floor up to 0.95, missing the anchor by a nickel.
  salary = clamp(Math.round(salary * 40) / 40, 0.925, 20);

  let years;
  if (player.age >= 34) {
    years = 1 + Math.round(Math.random());
  } else {
    years = clamp(Math.round(baseContractYears(player.age) + premiumStrength * 3), 1, 8);
    // Without a proven ceiling to bank on, a player under 25 wants to stay
    // flexible for their next contract rather than lock into term early —
    // long-term deals from players this young are earned by real upside,
    // not handed out by default.
    if (isYoung && !isHighPotential) years = clamp(years, 1, 3);
    // Replacement-level pay doesn't come with term either way — nobody
    // signs a long deal for a depth/bottom-six role.
    if (salary < 2) years = clamp(years, 1, 3);
  }

  return { aavMillions: salary, yearsRequested: years };
}

// --- Salary cap ---
//
// Upper limit only — no cap floor, and no LTIR/retention/buyout exceptions.
// This league runs its own house-rule cap ($160.0M for season 1, the
// 2026-27 season — see client/src/seasonYear.js) rather than the real NHL's
// actual announced $104.0M, deliberately raised to give the real imported
// rosters (whose real-NHL cap hits routinely exceeded $104M once assembled
// on one side) actual room to be cap-compliant. Season 2 continues at the
// same ~8.5%/year the real confirmed 2026-27 -> 2027-28 jump used, rounded
// to the nearest $0.5M, and every season past that extrapolates at that
// same rate — a placeholder curve, not real NHL numbers, flagged here so
// it's easy to find and adjust again later.
const KNOWN_CAP_CEILINGS = { 1: 160.0, 2: 173.5 }; // 2026-27, 2027-28
const CAP_GROWTH_RATE = 0.085;

function getCapCeiling(seasonNumber) {
  const lastKnownSeason = Math.max(...Object.keys(KNOWN_CAP_CEILINGS).map(Number));
  if (seasonNumber <= lastKnownSeason) {
    return KNOWN_CAP_CEILINGS[seasonNumber] ?? KNOWN_CAP_CEILINGS[lastKnownSeason];
  }
  let ceiling = KNOWN_CAP_CEILINGS[lastKnownSeason];
  for (let s = lastKnownSeason + 1; s <= seasonNumber; s++) {
    ceiling = Math.round(ceiling * (1 + CAP_GROWTH_RATE) * 2) / 2;
  }
  return ceiling;
}

// A player actually assigned to the minors doesn't count against the NHL
// cap in real life (waiver exceptions aside, which this app doesn't
// model) — only the active roster (dressed + healthy scratches) does.
function capContribution(player) {
  return player.lineupSlot === "MINORS" ? 0 : player.capHit;
}

function sumCapHit(players) {
  return Math.round(players.reduce((sum, p) => sum + capContribution(p), 0) * 1000) / 1000;
}

async function getTeamCapHit(teamId) {
  return sumCapHit(await getPlayersByTeam(teamId));
}

// { committed, ceiling, space } — space can go negative if a team is
// already over (shouldn't happen going forward now that every entry point
// is gated, but a team could already be over from before this shipped).
async function getTeamCapSummary(teamId) {
  const [committed, season] = await Promise.all([getTeamCapHit(teamId), getSeasonInfo()]);
  const ceiling = getCapCeiling(season.seasonNumber);
  return { committed, ceiling, space: Math.round((ceiling - committed) * 1000) / 1000 };
}

// Backfills otLosses/shutouts on goalie stats read from rows written before
// those fields existed, so old DB rows display 0 instead of undefined —
// same read-time-normalization pattern as resolvePotential, no migration
// script needed.
function normalizeStats(position, stats) {
  if (position !== "G") return stats;
  return { ...stats, otLosses: stats.otLosses ?? 0, shutouts: stats.shutouts ?? 0 };
}

function mapPlayerRow(row) {
  const player = {
    id: row.id,
    teamId: row.team_id,
    name: row.name,
    position: row.position,
    jerseyNumber: row.jersey_number,
    age: row.age,
    overall: row.overall,
    capHit: Number(row.cap_hit),
    contractYearsLeft: row.contract_years_left,
    inGameStatus: row.in_game_status,
    lineupSlot: row.roster_assignment,
    attributes: row.attributes,
    potential: resolvePotential(row.potential, row.age),
    stats: normalizeStats(row.position, row.stats),
  };
  player.contractDemand = computeContractDemand(player);
  player.tradeValue = computeTradeValue(player);
  return player;
}

function mapGameRow(row) {
  return {
    id: row.id,
    date: row.date,
    homeTeamId: row.home_team_id,
    awayTeamId: row.away_team_id,
    status: row.status,
    homeScore: row.home_score,
    awayScore: row.away_score,
    wentToOT: row.went_to_ot,
    source: row.source,
    boxScore: row.box_score,
  };
}

function gameType(game, teamsById) {
  const home = teamsById.get(game.homeTeamId).isHumanControlled;
  const away = teamsById.get(game.awayTeamId).isHumanControlled;
  if (home && away) return "human_vs_human";
  if (!home && !away) return "cpu_vs_cpu";
  return "human_vs_cpu";
}

function enrichGame(game, teamsById, leagueDate) {
  const type = gameType(game, teamsById);
  return {
    ...game,
    homeTeam: teamsById.get(game.homeTeamId),
    awayTeam: teamsById.get(game.awayTeamId),
    gameType: type,
    needsScore: game.status === "scheduled" && game.date <= leagueDate && type === "human_vs_human",
  };
}

async function getTeams() {
  const { rows } = await pool.query("SELECT * FROM teams ORDER BY id");
  return rows.map(mapTeamRow);
}

async function getTeamsById() {
  return new Map((await getTeams()).map((t) => [t.id, t]));
}

async function getLeagueDate() {
  const { rows } = await pool.query("SELECT league_date FROM league_state WHERE id = 1");
  return rows[0].league_date;
}

async function getPlayers() {
  const { rows } = await pool.query("SELECT * FROM players ORDER BY id");
  return rows.map(mapPlayerRow);
}

async function getPlayersByTeam(teamId) {
  const { rows } = await pool.query("SELECT * FROM players WHERE team_id = $1", [teamId]);
  return rows.map(mapPlayerRow);
}

// Goalie counterpart to /api/scorers — there was previously no leaderboard
// for goalies at all. Sorted by wins first (the conventional "leaders" sort
// for goalies), then save percentage as a tiebreak.
async function getGoalieLeaders({ teamId } = {}) {
  const [players, teams] = await Promise.all([getPlayers(), getTeams()]);
  const teamsById = new Map(teams.map((t) => [t.id, t]));

  return players
    .filter((p) => p.position === "G" && p.teamId !== null && (teamId == null || p.teamId === teamId))
    .map((p) => ({
      playerId: p.id,
      name: p.name,
      teamId: p.teamId,
      team: teamsById.get(p.teamId),
      gamesPlayed: p.stats.gamesPlayed,
      wins: p.stats.wins,
      losses: p.stats.losses,
      otLosses: p.stats.otLosses,
      goalsAgainstAverage: p.stats.goalsAgainstAverage,
      savePercentage: p.stats.savePercentage,
      shutouts: p.stats.shutouts,
    }))
    .sort((a, b) => b.wins - a.wins || b.savePercentage - a.savePercentage);
}

// Every stat used for League Leaders' skater table, unfiltered/unsorted by
// design beyond a stable default — the Stats page owns sort-by-column
// itself (see getGoalieLeaders' comment for why no server-side cap).
async function getScorers({ teamId } = {}) {
  const [players, teams] = await Promise.all([getPlayers(), getTeams()]);
  const teamsById = new Map(teams.map((t) => [t.id, t]));

  return players
    .filter((p) => p.position !== "G" && p.teamId !== null && (teamId == null || p.teamId === teamId))
    .map((p) => ({
      playerId: p.id,
      name: p.name,
      position: p.position,
      teamId: p.teamId,
      team: teamsById.get(p.teamId),
      gamesPlayed: p.stats.gamesPlayed,
      goals: p.stats.goals,
      assists: p.stats.assists,
      points: p.stats.points,
    }))
    .sort((a, b) => b.points - a.points || b.goals - a.goals);
}

async function getGames({ teamId } = {}) {
  const [teamsById, leagueDate] = await Promise.all([getTeamsById(), getLeagueDate()]);

  let text = "SELECT * FROM games";
  const params = [];
  if (teamId) {
    text += " WHERE home_team_id = $1 OR away_team_id = $1";
    params.push(teamId);
  }
  text += " ORDER BY date";

  const { rows } = await pool.query(text, params);
  return rows.map(mapGameRow).map((g) => enrichGame(g, teamsById, leagueDate));
}

async function getPendingHumanGames() {
  const games = await getGames();
  return games.filter((g) => g.needsScore);
}

// Moved here (from server.js) so draft-order projection can reuse the same
// standings computation instead of duplicating it.
async function getStandings() {
  const [teams, games] = await Promise.all([getTeams(), getGames()]);

  const table = new Map(
    teams.map((t) => [
      t.id,
      {
        teamId: t.id,
        city: t.city,
        name: t.name,
        abbr: t.abbr,
        conference: t.conference,
        division: t.division,
        gamesPlayed: 0,
        wins: 0,
        losses: 0,
        otLosses: 0,
        points: 0,
        goalsFor: 0,
        goalsAgainst: 0,
      },
    ])
  );

  games
    .filter((g) => g.status === "final")
    .forEach((g) => {
      const home = table.get(g.homeTeamId);
      const away = table.get(g.awayTeamId);
      home.gamesPlayed++;
      away.gamesPlayed++;
      home.goalsFor += g.homeScore;
      home.goalsAgainst += g.awayScore;
      away.goalsFor += g.awayScore;
      away.goalsAgainst += g.homeScore;

      if (g.homeScore > g.awayScore) {
        home.wins++;
        home.points += 2;
        if (g.wentToOT) {
          away.otLosses++;
          away.points += 1;
        } else {
          away.losses++;
        }
      } else {
        away.wins++;
        away.points += 2;
        if (g.wentToOT) {
          home.otLosses++;
          home.points += 1;
        } else {
          home.losses++;
        }
      }
    });

  return [...table.values()].sort((a, b) => b.points - a.points || b.wins - a.wins);
}

// --- Score submission (human_vs_human games, reported back from the console) ---
//
// Unlike CPU-simmed games, a human game's final score is derived FROM the
// box score (sum of each side's skater goals), not entered separately —
// there's no other source of truth for what happened, so the two can never
// drift out of sync. Editing an already-scored game reverses the previous
// submission's stat contributions (stored verbatim in games.box_score)
// before applying the new one, so corrections don't double-count.

function creditSkaterBoxScoreLine(stats, { goals, assists }, sign) {
  stats.gamesPlayed = (stats.gamesPlayed || 0) + sign;
  stats.goals = (stats.goals || 0) + sign * goals;
  stats.assists = (stats.assists || 0) + sign * assists;
  stats.points = (stats.points || 0) + sign * (goals + assists);
}

function creditGoalieBoxScoreLine(stats, { goalsFor, goalsAgainst, shotsFaced, wentToOT }, sign) {
  const won = goalsFor > goalsAgainst;
  stats.gamesPlayed = (stats.gamesPlayed || 0) + sign;
  if (won) stats.wins = (stats.wins || 0) + sign;
  else if (wentToOT) stats.otLosses = (stats.otLosses || 0) + sign;
  else stats.losses = (stats.losses || 0) + sign;
  if (goalsAgainst === 0) stats.shutouts = (stats.shutouts || 0) + sign;
  stats._goalsAgainstTotal = (stats._goalsAgainstTotal || 0) + sign * goalsAgainst;
  stats._shotsFacedTotal = (stats._shotsFacedTotal || 0) + sign * shotsFaced;
  stats.goalsAgainstAverage =
    stats.gamesPlayed > 0 ? Math.round((stats._goalsAgainstTotal / stats.gamesPlayed) * 100) / 100 : 0;
  stats.savePercentage =
    stats._shotsFacedTotal > 0
      ? Math.round((1 - stats._goalsAgainstTotal / stats._shotsFacedTotal) * 1000) / 1000
      : 0;
}

// sign: +1 to apply this side's box score line to every named player,
// -1 to reverse it (used when a correction supersedes a prior submission).
async function applyBoxScoreSide(client, side, opponentGoals, wentToOT, sign) {
  for (const s of side.skaters) {
    const { rows } = await client.query("SELECT stats FROM players WHERE id = $1", [s.playerId]);
    if (rows.length === 0) continue; // player no longer exists — nothing to (un)credit
    const stats = rows[0].stats;
    creditSkaterBoxScoreLine(stats, s, sign);
    await client.query("UPDATE players SET stats = $1 WHERE id = $2", [JSON.stringify(stats), s.playerId]);
  }

  const { rows: goalieRows } = await client.query("SELECT stats FROM players WHERE id = $1", [side.goalieId]);
  if (goalieRows.length === 0) return;
  const goalieStats = goalieRows[0].stats;
  const goalsFor = side.skaters.reduce((sum, s) => sum + s.goals, 0);
  creditGoalieBoxScoreLine(goalieStats, { goalsFor, goalsAgainst: opponentGoals, shotsFaced: side.shotsFaced, wentToOT }, sign);
  await client.query("UPDATE players SET stats = $1 WHERE id = $2", [JSON.stringify(goalieStats), side.goalieId]);
}

// Only the currently-dressed lineup (F1-F4/D1-D3 skaters, G1/G2 goalies) is
// eligible — same rule the CPU sim uses, so a human box score can't credit
// someone sitting in the minors/scratched.
async function validateBoxScoreSide(teamId, side) {
  if (!side || !Array.isArray(side.skaters)) {
    throw badRequest("Each side needs a goalieId, shotsFaced, and a skaters array");
  }
  const roster = await getPlayersByTeam(teamId);
  const dressedSkaterIds = new Set(
    roster.filter((p) => p.position !== "G" && isDressedSlot(p.lineupSlot)).map((p) => p.id)
  );
  const dressedGoalieIds = new Set(
    roster.filter((p) => p.position === "G" && (p.lineupSlot === "G1" || p.lineupSlot === "G2")).map((p) => p.id)
  );

  if (!Number.isInteger(side.goalieId) || !dressedGoalieIds.has(side.goalieId)) {
    throw badRequest("goalieId must be one of this team's currently dressed goalies (G1/G2)");
  }
  if (!Number.isInteger(side.shotsFaced) || side.shotsFaced < 0) {
    throw badRequest("shotsFaced must be a non-negative integer");
  }
  const seen = new Set();
  for (const s of side.skaters) {
    if (!dressedSkaterIds.has(s.playerId)) {
      throw badRequest(`Player ${s.playerId} isn't currently dressed (F1-F4/D1-D3) for this team`);
    }
    if (seen.has(s.playerId)) throw badRequest(`Player ${s.playerId} appears twice in the box score`);
    seen.add(s.playerId);
    if (!Number.isInteger(s.goals) || s.goals < 0 || !Number.isInteger(s.assists) || s.assists < 0) {
      throw badRequest(`Goals/assists must be non-negative integers for player ${s.playerId}`);
    }
  }
}

async function submitScore(gameId, { wentToOT, home, away }) {
  const id = Number(gameId);
  const teamsById = await getTeamsById();

  return withTransaction(async (client) => {
    const gameRes = await client.query("SELECT * FROM games WHERE id = $1 FOR UPDATE", [id]);
    if (gameRes.rows.length === 0) throw notFound("Game not found");
    const game = mapGameRow(gameRes.rows[0]);

    if (gameType(game, teamsById) !== "human_vs_human") {
      throw badRequest("Only human_vs_human games are scored manually — CPU-involved games are simulated");
    }

    await validateBoxScoreSide(game.homeTeamId, home);
    await validateBoxScoreSide(game.awayTeamId, away);

    const homeScore = home.skaters.reduce((sum, s) => sum + s.goals, 0);
    const awayScore = away.skaters.reduce((sum, s) => sum + s.goals, 0);
    if (homeScore === awayScore) {
      throw badRequest("A final score cannot be tied — check every goal is entered, including the OT winner");
    }
    if (home.shotsFaced < awayScore) {
      throw badRequest("Home goalie's shots faced can't be less than the away team's goals");
    }
    if (away.shotsFaced < homeScore) {
      throw badRequest("Away goalie's shots faced can't be less than the home team's goals");
    }

    if (game.boxScore) {
      const prevAwayGoals = game.boxScore.away.skaters.reduce((s, p) => s + p.goals, 0);
      const prevHomeGoals = game.boxScore.home.skaters.reduce((s, p) => s + p.goals, 0);
      await applyBoxScoreSide(client, game.boxScore.home, prevAwayGoals, game.boxScore.wentToOT, -1);
      await applyBoxScoreSide(client, game.boxScore.away, prevHomeGoals, game.boxScore.wentToOT, -1);
    }

    await applyBoxScoreSide(client, home, awayScore, Boolean(wentToOT), 1);
    await applyBoxScoreSide(client, away, homeScore, Boolean(wentToOT), 1);

    const boxScore = { wentToOT: Boolean(wentToOT), home, away };
    await client.query(
      `UPDATE games SET status = 'final', home_score = $1, away_score = $2, went_to_ot = $3, source = 'manual', box_score = $4
       WHERE id = $5`,
      [homeScore, awayScore, Boolean(wentToOT), JSON.stringify(boxScore), id]
    );

    const leagueDate = await getLeagueDate();
    const updated = await client.query("SELECT * FROM games WHERE id = $1", [id]);
    return enrichGame(mapGameRow(updated.rows[0]), teamsById, leagueDate);
  });
}

// --- CPU simulation (human_vs_cpu and cpu_vs_cpu games) ---

// A player only accumulates stats for a game if they're actually dressed —
// one of the 12 forward-line or 6 defense-pair slots (see buildLineupSlots).
// SCRATCH and MINORS players don't play. Used both to pick who's eligible to
// score/assist and, weighted below, how heavily.
function isDressedSlot(lineupSlot) {
  return lineupSlot.startsWith("F") || lineupSlot.startsWith("D");
}

// Relative ice time by line/pairing — first-guess constants (like every
// other tuning knob in this file), calibrated only for "clearly visible top
// line vs bottom line skew, without making the bottom lines statistically
// irrelevant." A great shooter's attribute edge can still overcome a worse
// line assignment on any given goal; this only shifts the odds.
const FORWARD_LINE_ICE_TIME = { 1: 1.0, 2: 0.78, 3: 0.58, 4: 0.42 };
const DEFENSE_PAIR_ICE_TIME = { 1: 0.75, 2: 0.58, 3: 0.42 };

function iceTimeWeight(lineupSlot) {
  if (lineupSlot.startsWith("F")) return FORWARD_LINE_ICE_TIME[Number(lineupSlot[1])] ?? 0.5;
  if (lineupSlot.startsWith("D")) return DEFENSE_PAIR_ICE_TIME[Number(lineupSlot[1])] ?? 0.5;
  return 0.5;
}

// How much of a team's starts the backup (G2) gets, as a function of the
// overall gap to the starter (G1) — the starter's slot assignment always
// wins the coin flip more often than not (capped below 50%), but a backup
// rated close to the starter closes that gap toward an even split, per the
// user's own framing of the rule. First-guess constants, not derived from
// anything authoritative.
const BACKUP_SHARE_BASE = 0.5;
const BACKUP_SHARE_PER_OVERALL_GAP = 0.03;
const BACKUP_MIN_SHARE = 0.06;
const BACKUP_MAX_SHARE = 0.48;

function backupStartShare(starterOverall, backupOverall) {
  const gap = starterOverall - backupOverall;
  return clamp(BACKUP_SHARE_BASE - gap * BACKUP_SHARE_PER_OVERALL_GAP, BACKUP_MIN_SHARE, BACKUP_MAX_SHARE);
}

// Picks which of a team's dressed goalies plays THIS game — re-rolled every
// call rather than following a fixed rotation, so a season-long games-played
// split emerges from many independent draws instead of a scripted schedule.
function chooseStartingGoalie(goalies) {
  if (goalies.length === 0) return null;
  if (goalies.length === 1) return goalies[0];
  const starter = goalies.find((g) => g.lineupSlot === "G1") ?? goalies[0];
  const backup = goalies.find((g) => g.id !== starter.id) ?? goalies[1];
  const share = backupStartShare(starter.overall, backup.overall);
  return Math.random() < share ? backup : starter;
}

async function teamStrength(client, teamId) {
  const { rows } = await client.query("SELECT * FROM players WHERE team_id = $1", [teamId]);
  const roster = rows.map(mapPlayerRow);
  const dressedSkaters = roster.filter((p) => p.position !== "G" && isDressedSlot(p.lineupSlot));
  // Falls back to the whole non-goalie roster if the lineup was never set
  // (e.g. a brand new league before autoSetLineup/Set Lineup has run) —
  // better than a team fielding zero skaters.
  const skaters = dressedSkaters.length > 0 ? dressedSkaters : roster.filter((p) => p.position !== "G");
  const dressedGoalies = roster.filter((p) => p.position === "G" && (p.lineupSlot === "G1" || p.lineupSlot === "G2"));
  const goalie = chooseStartingGoalie(
    dressedGoalies.length > 0 ? dressedGoalies : roster.filter((p) => p.position === "G")
  );
  const offense = mean(
    skaters.map(
      (p) =>
        categoryAverage(p.attributes, ATTRIBUTE_CATEGORIES.shooting) * 0.5 +
        p.attributes.passing * 0.3 +
        p.overall * 0.2
    )
  );
  const skaterDefense = mean(skaters.map((p) => categoryAverage(p.attributes, ATTRIBUTE_CATEGORIES.defense)));
  const defense = skaterDefense * 0.55 + (goalie ? goalie.overall : 75) * 0.45;
  return { offense, defense, skaters, goalie };
}

function poissonSample(lambda) {
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= Math.random();
  } while (p > limit);
  return k - 1;
}

function weightedPick(pool_, weightFn) {
  const total = pool_.reduce((sum, p) => sum + weightFn(p), 0);
  let r = Math.random() * total;
  for (const p of pool_) {
    r -= weightFn(p);
    if (r <= 0) return p;
  }
  return pool_[pool_.length - 1];
}

// Weighted, without-replacement sampling of up to n items — used to pick
// which skaters were "on the ice" for a goal against, biased toward players
// who actually get more ice time rather than a uniform random 4.
function weightedSampleWithoutReplacement(pool_, n, weightFn) {
  const remaining = [...pool_];
  const picked = [];
  for (let i = 0; i < n && remaining.length > 0; i++) {
    const chosen = weightedPick(remaining, weightFn);
    picked.push(chosen);
    remaining.splice(remaining.indexOf(chosen), 1);
  }
  return picked;
}

// Real-hockey scoring skews toward forwards despite 12 forwards vs only 6
// defensemen dressed — defensemen get relatively more of their offense from
// assists (point shots, quarterbacking the power play) than from actually
// scoring goals. These are per-player weights (forwards stay at the
// implicit 1x), tuned against the 12-forward/6-defenseman dressed split so
// the resulting LEAGUE-WIDE share works out to ~75/25 forwards/D on goals
// and an even 50/50 split on assists — e.g. 50/50 needs D weighted at 2x
// per player, since there are half as many of them. Not shooting/passing
// attributes alone (which don't otherwise distinguish a puck-moving D from
// a scoring winger).
const DEFENSEMAN_GOAL_WEIGHT = 0.9;
const DEFENSEMAN_ASSIST_WEIGHT = 1.45;

// Raw shooting/passing ratings only span ~60-96 across the whole league
// (median ~85), so raising them to a power directly barely separates a true
// star from a solid role player (93.5 vs 87.5 shooting, ^1.5, is only ~10%
// apart) — variance across a game's few scoring chances then swamps the
// skill gap entirely. Shifting the scale down by a floor before the power
// stretches that same raw gap much further apart (the same two players
// become ~40% apart), while a real depth guy down near the floor still gets
// a small nonzero shot rather than being locked out — "usually, not
// always" the better player scores, exactly as intended.
const SKILL_WEIGHT_FLOOR = 55;
const SKILL_WEIGHT_EXPONENT = 2;

function skillWeight(rating) {
  return Math.max(1, rating - SKILL_WEIGHT_FLOOR) ** SKILL_WEIGHT_EXPONENT;
}

function distributeGoals(teamInfo, goalsFor, goalsAgainst, wentToOT) {
  const { skaters, goalie } = teamInfo;
  skaters.forEach((p) => {
    p.stats.gamesPlayed += 1;
  });
  if (goalie) goalie.stats.gamesPlayed += 1;

  for (let i = 0; i < goalsFor; i++) {
    const scorer = weightedPick(
      skaters,
      (p) =>
        iceTimeWeight(p.lineupSlot) *
        skillWeight(categoryAverage(p.attributes, ATTRIBUTE_CATEGORIES.shooting)) *
        (p.position === "D" ? DEFENSEMAN_GOAL_WEIGHT : 1)
    );
    scorer.stats.goals += 1;
    scorer.stats.points += 1;
    scorer.stats.plusMinus += 1;

    // Real NHL goals average ~1.6 assists apiece (most are 2-assist goals,
    // only ~1 in 10 unassisted) — the old 0-25/1-30/2-45 split only
    // averaged 1.2, starving even good playmaking forwards of the assist
    // volume real box scores show, which let pure shooters end up with more
    // goals than assists (uncommon for anyone but a true power forward).
    const assistRoll = Math.random();
    const assistCount = assistRoll < 0.08 ? 0 : assistRoll < 0.32 ? 1 : 2;
    const used = new Set([scorer.id]);
    for (let a = 0; a < assistCount; a++) {
      const candidates = skaters.filter((p) => !used.has(p.id));
      if (candidates.length === 0) break;
      const assister = weightedPick(
        candidates,
        (p) => iceTimeWeight(p.lineupSlot) * skillWeight(p.attributes.passing) * (p.position === "D" ? DEFENSEMAN_ASSIST_WEIGHT : 1)
      );
      assister.stats.assists += 1;
      assister.stats.points += 1;
      assister.stats.plusMinus += 1;
      used.add(assister.id);
    }
  }

  for (let i = 0; i < goalsAgainst; i++) {
    weightedSampleWithoutReplacement(skaters, 4, (p) => iceTimeWeight(p.lineupSlot)).forEach((p) => {
      p.stats.plusMinus -= 1;
    });
  }

  if (goalie) {
    const shotsFaced = goalsAgainst + 20 + Math.floor(Math.random() * 12);
    const won = goalsFor > goalsAgainst;
    if (won) goalie.stats.wins += 1;
    else if (wentToOT) goalie.stats.otLosses += 1;
    else goalie.stats.losses += 1;
    if (goalsAgainst === 0) goalie.stats.shutouts += 1;
    goalie.stats._goalsAgainstTotal += goalsAgainst;
    goalie.stats._shotsFacedTotal += shotsFaced;
    goalie.stats.goalsAgainstAverage =
      Math.round((goalie.stats._goalsAgainstTotal / goalie.stats.gamesPlayed) * 100) / 100;
    goalie.stats.savePercentage =
      Math.round((1 - goalie.stats._goalsAgainstTotal / goalie.stats._shotsFacedTotal) * 1000) / 1000;
  }
}

async function persistRoster(client, teamInfo) {
  const all = teamInfo.goalie ? [...teamInfo.skaters, teamInfo.goalie] : teamInfo.skaters;
  for (const p of all) {
    await client.query("UPDATE players SET stats = $1 WHERE id = $2", [JSON.stringify(p.stats), p.id]);
  }
}

async function simulateGame(gameId) {
  const id = Number(gameId);
  const teamsById = await getTeamsById();

  return withTransaction(async (client) => {
    const gameRes = await client.query("SELECT * FROM games WHERE id = $1 FOR UPDATE", [id]);
    if (gameRes.rows.length === 0) throw notFound("Game not found");
    const game = mapGameRow(gameRes.rows[0]);

    if (gameType(game, teamsById) === "human_vs_human") {
      throw badRequest("human_vs_human games are reported from the console, not simulated");
    }

    const home = await teamStrength(client, game.homeTeamId);
    const away = await teamStrength(client, game.awayTeamId);

    // Base rate (goals/team/game before the opponent-defense ratio and home
    // ice bump) — bumped 40% per the user's own request, up from 2.6.
    const BASE_GOALS_PER_TEAM = 2.6 * 1.4;
    const homeExpected = BASE_GOALS_PER_TEAM * (home.offense / away.defense) * 1.06;
    const awayExpected = BASE_GOALS_PER_TEAM * (away.offense / home.defense);

    let homeGoals = poissonSample(homeExpected);
    let awayGoals = poissonSample(awayExpected);
    let wentToOT = false;

    if (homeGoals === awayGoals) {
      wentToOT = true;
      if (Math.random() < 0.5) homeGoals += 1;
      else awayGoals += 1;
    }

    distributeGoals(home, homeGoals, awayGoals, wentToOT);
    distributeGoals(away, awayGoals, homeGoals, wentToOT);

    await persistRoster(client, home);
    await persistRoster(client, away);

    await client.query(
      `UPDATE games SET status = 'final', home_score = $1, away_score = $2, went_to_ot = $3, source = 'sim'
       WHERE id = $4`,
      [homeGoals, awayGoals, wentToOT, id]
    );

    const leagueDate = await getLeagueDate();
    const updated = await client.query("SELECT * FROM games WHERE id = $1", [id]);
    return enrichGame(mapGameRow(updated.rows[0]), teamsById, leagueDate);
  });
}

async function advanceSimulation() {
  const teamsById = await getTeamsById();
  const leagueDate = await getLeagueDate();
  const { rows } = await pool.query("SELECT * FROM games WHERE status = 'scheduled' AND date <= $1", [leagueDate]);
  const due = rows.map(mapGameRow).filter((g) => gameType(g, teamsById) !== "human_vs_human");

  const simmed = [];
  for (const g of due) {
    simmed.push(await simulateGame(g.id));
  }
  return simmed;
}

// "Once all games are played in NHL 27, the commissioner simulates the
// whole rest of the season" — unlike advanceSimulation (date-gated to
// "due" games only), this simulates every remaining CPU-involved game
// regardless of date, since the season's actually over on the console by
// the time this gets used. Refuses to run at all if any human-vs-human
// game is still unscored, since those can only ever come from a manual
// score entry, never simulation.
async function simulateAllRemainingGames() {
  const games = await getGames();
  const pendingHuman = games.filter((g) => g.gameType === "human_vs_human" && g.status !== "final");
  if (pendingHuman.length > 0) {
    throw badRequest(
      `${pendingHuman.length} human-vs-human game(s) still need a score before the season can be simulated`
    );
  }

  const pendingCpu = games.filter((g) => g.gameType !== "human_vs_human" && g.status !== "final");
  const simmed = [];
  for (const g of pendingCpu) {
    simmed.push(await simulateGame(g.id));
  }

  if (simmed.length > 0) {
    const lastDate = games.reduce((max, g) => (g.date > max ? g.date : max), games[0].date);
    await pool.query("UPDATE league_state SET league_date = $1 WHERE id = 1", [lastDate]);
  }

  return { simmedCount: simmed.length, games: simmed };
}

// --- Playoffs ---
//
// "For now, we will just select the winner of the playoffs" — no bracket or
// qualification logic until NHL 27 itself ships and it's clear how playoffs
// actually work on the console. A table (not a mutable league_state field)
// so each season's result is kept, not overwritten by the next season's.

async function setPlayoffChampion({ teamId }) {
  const leaguePhase = await getLeaguePhase();
  if (leaguePhase.phase !== "playoffs") {
    throw badRequest(`A playoff champion can only be set during the 'playoffs' phase`);
  }
  const teams = await getTeams();
  const team = teams.find((t) => t.id === teamId);
  if (!team) throw notFound(`Team ${teamId} not found`);

  await pool.query(
    `INSERT INTO season_results (season_number, champion_team_id) VALUES ($1, $2)
     ON CONFLICT (season_number) DO UPDATE SET champion_team_id = EXCLUDED.champion_team_id`,
    [leaguePhase.seasonNumber, teamId]
  );
  return getSeasonResults();
}

async function getSeasonResults() {
  const teamsById = await getTeamsById();
  const { rows } = await pool.query("SELECT * FROM season_results ORDER BY season_number DESC");
  return rows.map((r) => ({
    seasonNumber: r.season_number,
    champion: r.champion_team_id != null ? teamsById.get(r.champion_team_id) : null,
  }));
}

async function advanceLeagueDate(days) {
  if (!Number.isInteger(days) || days <= 0) {
    throw badRequest("days must be a positive integer");
  }
  const current = await getLeagueDate();
  const newDate = addDays(current, days);
  await pool.query("UPDATE league_state SET league_date = $1 WHERE id = 1", [newDate]);
  const simmed = await advanceSimulation();
  return { leagueDate: newDate, simmedCount: simmed.length, games: simmed };
}

async function getSeasonInfo() {
  const stateRes = await pool.query("SELECT * FROM league_state WHERE id = 1");
  const state = stateRes.rows[0];
  const aggRes = await pool.query(
    `SELECT MIN(date) AS start_date, MAX(date) AS end_date, COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'final')::int AS completed
     FROM games`
  );
  const agg = aggRes.rows[0];
  return {
    seasonNumber: state.season_number,
    leagueDate: state.league_date,
    startDate: agg.start_date,
    endDate: agg.end_date,
    totalGames: agg.total,
    gamesCompleted: agg.completed,
    gamesRemaining: agg.total - agg.completed,
    capCeiling: getCapCeiling(state.season_number),
  };
}

// --- Season phase state machine ---
//
// The season is a fixed, ordered pipeline of phases (free agency -> trades
// -> roster lock -> NHL 27 sync -> games -> playoffs -> post-playoff trade
// -> draft -> progression -> re-signing -> loop). `rounds` is how many
// times a phase repeats (its "round N of rounds") before moving on to the
// next entry — single-pass phases just use rounds: 1. This table is the
// single source of truth for phase order; nothing else hardcodes "what
// comes next."
const PHASE_SEQUENCE = [
  { phase: "free_agency", rounds: 3 },
  { phase: "trade_period", rounds: 5 },
  { phase: "set_roster", rounds: 1 },
  { phase: "roster_update", rounds: 1 },
  { phase: "regular_season", rounds: 1 },
  { phase: "playoffs", rounds: 1 },
  { phase: "post_playoff_trade", rounds: 1 },
  { phase: "draft", rounds: 1 },
  { phase: "progression", rounds: 1 },
  { phase: "resigning", rounds: 3 },
];

// Runs whatever validation/side effects belong to LEAVING a phase's current
// round — e.g. resolving that round's free agency bids, or refusing to
// leave `regular_season` while games are still unplayed. Wired as a no-op
// stub per phase for now (the season loop is fully clickable end-to-end
// before any single phase's real logic exists); each later build slice
// replaces its own entry here with real resolution/exit-gating logic as
// that phase's data model gets built, without touching this file's control
// flow.
const PHASE_RESOLVERS = {
  free_agency: async (state) => {
    await generateCpuFreeAgentBids(state.season_number, state.phase_round);
    return resolveFreeAgencyRound(state.season_number, state.phase_round);
  },
  // Bidding continues into the trade period too (per the user's spec),
  // alongside resolving that round's CPU-trade proposals.
  trade_period: async (state) => {
    await generateCpuFreeAgentBids(state.season_number, state.phase_round);
    await resolveFreeAgencyRound(state.season_number, state.phase_round);
    await resolveTradeProposals(state.season_number, state.phase_round, "trade_period");
    for (let i = 0; i < CPU_VS_CPU_OFFERS_PER_ROUND; i++) {
      await generateCpuVsCpuTrade(state.season_number);
    }
  },
  // No exit-gating needed — a GM can leave players active-only and that's
  // fine, sending someone to minors is optional, not required to advance.
  set_roster: async () => {},
  // Applies every pending NHL 27 change and generates the season's
  // schedule now that rosters are final — see confirmRosterUpdate.
  roster_update: async () => confirmRosterUpdate(),
  // Can't move on to playoffs with games still unplayed — the commissioner
  // must either finish manual score entry or run simulateAllRemainingGames
  // first (both surfaced as separate explicit actions, not auto-run here).
  regular_season: async () => {
    const season = await getSeasonInfo();
    if (season.gamesRemaining > 0) {
      throw badRequest(
        `${season.gamesRemaining} game(s) still remain this season — submit remaining scores or simulate the rest before advancing`
      );
    }
  },
  playoffs: async (state) => {
    const { rows } = await pool.query("SELECT champion_team_id FROM season_results WHERE season_number = $1", [
      state.season_number,
    ]);
    if (rows.length === 0 || rows[0].champion_team_id == null) {
      throw badRequest("Select a playoff champion before advancing past the playoffs phase");
    }
  },
  post_playoff_trade: async (state) => {
    await resolveTradeProposals(state.season_number, state.phase_round, "post_playoff_trade");
    for (let i = 0; i < CPU_VS_CPU_OFFERS_PER_ROUND; i++) {
      await generateCpuVsCpuTrade(state.season_number);
    }
  },
  draft: async (state) => {
    const orderedPicks = await getOrderedDraftPicks(state.season_number);
    if (state.current_pick_index < orderedPicks.length) {
      throw badRequest(`The draft isn't finished — ${orderedPicks.length - state.current_pick_index} pick(s) remain`);
    }
  },
  // The existing standalone Progression tab/endpoint still works any time,
  // but advancing out of this phase is what actually drives it forward in
  // the normal season flow — same "one universal Advance Phase action"
  // pattern as roster_update's confirmRosterUpdate.
  progression: async () => {
    await runProgression();
  },
  resigning: async (state) => {
    await generateCpuResignOffers(state.season_number, state.phase_round);
    return resolveResigningRound(state.season_number, state.phase_round);
  },
};

async function getLeaguePhase() {
  const { rows } = await pool.query("SELECT season_number, phase, phase_round FROM league_state WHERE id = 1");
  const state = rows[0];
  const step = PHASE_SEQUENCE.find((s) => s.phase === state.phase) ?? PHASE_SEQUENCE[0];
  return {
    seasonNumber: state.season_number,
    phase: state.phase,
    phaseRound: state.phase_round,
    totalRounds: step.rounds,
  };
}

// The one commissioner action that drives the entire season loop — mirrors
// advanceLeagueDate/advanceSimulation's "single clear entry point" pattern
// rather than scattering a separate per-phase advance function with
// duplicated round/transition bookkeeping.
async function advanceLeaguePhase() {
  const { rows } = await pool.query("SELECT * FROM league_state WHERE id = 1");
  const state = rows[0];
  const stepIndex = PHASE_SEQUENCE.findIndex((s) => s.phase === state.phase);
  if (stepIndex === -1) throw badRequest(`Unknown league phase '${state.phase}'`);
  const step = PHASE_SEQUENCE[stepIndex];

  await PHASE_RESOLVERS[state.phase](state);

  if (state.phase_round < step.rounds) {
    await pool.query("UPDATE league_state SET phase_round = phase_round + 1 WHERE id = 1");
  } else if (stepIndex < PHASE_SEQUENCE.length - 1) {
    const nextPhase = PHASE_SEQUENCE[stepIndex + 1].phase;
    if (nextPhase === "draft") {
      // Entering the draft always starts the pick order over from the top.
      await pool.query("UPDATE league_state SET phase = $1, phase_round = 1, current_pick_index = 0 WHERE id = 1", [
        nextPhase,
      ]);
    } else {
      await pool.query("UPDATE league_state SET phase = $1, phase_round = 1 WHERE id = 1", [nextPhase]);
    }
  } else {
    // Re-signing round 3 just resolved — loop into a new season. The
    // season-number bump is purely structural (belongs here regardless of
    // which slice is being built), but draft picks/class regeneration
    // reuse the exact functions the draft-picks and draft-board features
    // already shipped with, applied to the new season number.
    const newSeasonNumber = state.season_number + 1;

    // Every rostered contract ages exactly one season here (once per full
    // trip through the loop) — anyone hitting 0 who wasn't just re-signed
    // becomes an open free agent for the new season's free_agency phase.
    // CPU teams have no resign logic, so their expiring players simply
    // walk to free agency the same way — no special-casing needed.
    // Freshly re-signed contracts (and draft-day entry-level deals, which
    // are also signed after this season's games already happened) were
    // stored with a compensating +1 specifically so this decrement lands
    // them on the real agreed term instead of eroding it immediately.
    await pool.query(
      `UPDATE players SET contract_years_left = contract_years_left - 1
       WHERE team_id IS NOT NULL AND contract_years_left > 0`
    );
    await pool.query("UPDATE players SET team_id = NULL WHERE team_id IS NOT NULL AND contract_years_left <= 0");

    await pool.query(
      "UPDATE league_state SET phase = 'free_agency', phase_round = 1, season_number = $1 WHERE id = 1",
      [newSeasonNumber]
    );
    await ensureDraftPicksThroughWindow(newSeasonNumber);
    await generateRandomDraftClass(newSeasonNumber);
  }

  return getLeaguePhase();
}

// Every human-controlled team's ready/not-ready state for the CURRENT
// phase/round checkpoint — CPU teams don't get a say, there's no GM to ask.
async function getReadyStatus() {
  const phase = await getLeaguePhase();
  const teams = await getTeams();
  const humanTeams = teams.filter((t) => t.isHumanControlled);
  const { rows } = await pool.query(
    "SELECT team_id FROM phase_ready_teams WHERE season_number = $1 AND phase = $2 AND phase_round = $3",
    [phase.seasonNumber, phase.phase, phase.phaseRound]
  );
  const readyIds = new Set(rows.map((r) => r.team_id));
  const teamStatuses = humanTeams.map((t) => ({
    teamId: t.id,
    city: t.city,
    name: t.name,
    ready: readyIds.has(t.id),
  }));
  return {
    seasonNumber: phase.seasonNumber,
    phase: phase.phase,
    phaseRound: phase.phaseRound,
    teams: teamStatuses,
    readyCount: teamStatuses.filter((t) => t.ready).length,
    totalCount: teamStatuses.length,
    allReady: teamStatuses.length > 0 && teamStatuses.every((t) => t.ready),
  };
}

// Marks (or unmarks) one team ready for the current checkpoint, then — if
// that was the last team needed — attempts the exact same advance the
// commissioner's manual button runs. If the phase's own exit condition
// isn't actually met yet (games still remaining, draft unfinished, etc.),
// the attempt just fails quietly and the ready flags stay put; the next
// person to toggle ready re-triggers this check, and the commissioner can
// always still force it manually regardless of readiness.
async function setTeamReady(teamId, ready) {
  const teams = await getTeams();
  const team = teams.find((t) => t.id === teamId);
  if (!team) throw notFound("Team not found");
  if (!team.isHumanControlled) throw badRequest("Only human-controlled teams can mark themselves ready");

  const before = await getLeaguePhase();
  if (ready) {
    await pool.query(
      `INSERT INTO phase_ready_teams (season_number, phase, phase_round, team_id)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [before.seasonNumber, before.phase, before.phaseRound, teamId]
    );
  } else {
    await pool.query(
      "DELETE FROM phase_ready_teams WHERE season_number = $1 AND phase = $2 AND phase_round = $3 AND team_id = $4",
      [before.seasonNumber, before.phase, before.phaseRound, teamId]
    );
  }

  const status = await getReadyStatus();
  if (!status.allReady) {
    return { advanced: false, status };
  }

  try {
    await advanceLeaguePhase();
  } catch (err) {
    return { advanced: false, status, blockedReason: err.message };
  }

  // The checkpoint everyone just cleared is now in the past — sweep it so
  // the new phase/round doesn't start out with leftover rows tied to a
  // different (season, phase, round) tuple than the one teams will actually
  // be readying up for next.
  await pool.query(
    "DELETE FROM phase_ready_teams WHERE season_number = $1 AND phase = $2 AND phase_round = $3",
    [before.seasonNumber, before.phase, before.phaseRound]
  );

  return { advanced: true, status: await getReadyStatus() };
}

// Wipes the current schedule and replaces it with a freshly generated round
// robin. Prior seasons' games aren't archived — only the live schedule
// reflects the new one. Deliberately does NOT touch season_number or draft
// picks/class — those are handled by the free_agency loop-around in
// advanceLeaguePhase (see PHASE_SEQUENCE) at the START of a season's cycle,
// while THIS runs at the END of the roster_update phase, right before games
// begin, once free agency/trades/draft have all finished shaping the
// rosters the schedule is actually being built for.
async function generateSeasonSchedule({ startDate, daysBetweenRounds = 3 } = {}) {
  const teams = await getTeams();
  const stateRes = await pool.query("SELECT * FROM league_state WHERE id = 1");
  const state = stateRes.rows[0];
  const effectiveStart = startDate || addDays(state.league_date, 7);

  const generated = generateNhlStyleSchedule(teams, { startDate: effectiveStart, daysBetweenRounds });

  await withTransaction(async (client) => {
    await client.query("DELETE FROM games");
    let nextId = state.next_game_id;
    for (const g of generated) {
      await client.query(
        `INSERT INTO games (id, date, home_team_id, away_team_id, status, home_score, away_score, went_to_ot, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [nextId, g.date, g.homeTeamId, g.awayTeamId, g.status, g.homeScore, g.awayScore, g.wentToOT, g.source]
      );
      nextId++;
    }
    await client.query("UPDATE league_state SET league_date = $1, next_game_id = $2 WHERE id = 1", [
      effectiveStart,
      nextId,
    ]);
  });

  await advanceSimulation();
  return getSeasonInfo();
}

// --- Set roster (line editor, NHL-15-"Edit Lines"-style) + commissioner roster update ---
//
// Every player always has exactly one `lineupSlot`: one of the 20 fixed,
// one-player-only slots below (4 forward lines x LW/C/RW, 3 defense pairs x
// L/R, starter + backup goalie), the many-player SCRATCH bucket (capped at
// 5), or the MINORS bucket (unlimited, and the default for anyone not
// explicitly placed — see schema.sql). Persists across seasons until
// explicitly changed again. Editable in any phase, not just `set_roster` —
// real GMs call players up and send them down all season long for cap and
// lineup reasons, not just once before the schedule locks. `set_roster`
// still exists as the one required checkpoint before the season starts,
// it's just no longer the only opportunity.
function buildLineupSlots() {
  const slots = [];
  for (let line = 1; line <= 4; line++) {
    for (const positionLabel of ["LW", "C", "RW"]) {
      slots.push({ slot: `F${line}_${positionLabel}`, group: "forward", line, positionLabel });
    }
  }
  for (let line = 1; line <= 3; line++) {
    slots.push({ slot: `D${line}_L`, group: "defense", line, positionLabel: "LD" });
    slots.push({ slot: `D${line}_R`, group: "defense", line, positionLabel: "RD" });
  }
  slots.push({ slot: "G1", group: "goalie", line: 1, positionLabel: "Starter" });
  slots.push({ slot: "G2", group: "goalie", line: 2, positionLabel: "Backup" });
  return slots;
}
const LINEUP_SLOTS = buildLineupSlots();
const LINEUP_SLOT_SET = new Set(LINEUP_SLOTS.map((s) => s.slot));
const SCRATCH_SLOT = "SCRATCH";
const MINORS_SLOT = "MINORS";
const MAX_SCRATCHES = 5;

function getLineupSlots() {
  return { slots: LINEUP_SLOTS, scratchSlot: SCRATCH_SLOT, minorsSlot: MINORS_SLOT, maxScratches: MAX_SCRATCHES };
}

// Click-a-player-then-a-target semantics: the client always passes the
// *target's current slot* as targetSlot (whether that target is an empty
// line spot, an occupied one, or the scratch/minors pool). If targetSlot is
// one of the 20 unique slots and someone else already holds it, that player
// is automatically displaced into the mover's old slot — a true two-way
// swap in one call. SCRATCH/MINORS are unlimited-ish buckets (SCRATCH capped
// at 5), so landing on either never displaces anyone.
async function assignLineupSlot({ teamId, playerId, targetSlot }) {
  if (targetSlot !== SCRATCH_SLOT && targetSlot !== MINORS_SLOT && !LINEUP_SLOT_SET.has(targetSlot)) {
    throw badRequest(`Unknown lineup slot '${targetSlot}'`);
  }

  await withTransaction(async (client) => {
    // FOR UPDATE locks this team's roster rows for the rest of the
    // transaction — two assignLineupSlot calls landing close together (a
    // fast double-click, two tabs, a human and an automated test both
    // touching the same team) used to each read the roster BEFORE the
    // transaction started, so the second call's "who's in this slot"
    // answer could already be stale by the time it wrote, corrupting into
    // two players sharing one slot. Reading fresh, locked rows here makes
    // the second call block until the first commits, then see its result.
    const { rows } = await client.query("SELECT id, roster_assignment FROM players WHERE team_id = $1 FOR UPDATE", [
      teamId,
    ]);
    const mover = rows.find((p) => p.id === playerId);
    if (!mover) throw notFound(`Player ${playerId} not found on team ${teamId}`);
    const moverOldSlot = mover.roster_assignment;

    if (targetSlot === SCRATCH_SLOT) {
      const scratchCount = rows.filter((p) => p.roster_assignment === SCRATCH_SLOT && p.id !== playerId).length;
      if (scratchCount >= MAX_SCRATCHES) throw badRequest("Scratches are already full (5/5)");
      await client.query("UPDATE players SET roster_assignment = $1 WHERE id = $2", [SCRATCH_SLOT, playerId]);
    } else if (targetSlot === MINORS_SLOT) {
      await client.query("UPDATE players SET roster_assignment = $1 WHERE id = $2", [MINORS_SLOT, playerId]);
    } else {
      const occupant = rows.find((p) => p.roster_assignment === targetSlot && p.id !== playerId);
      if (occupant) {
        await client.query("UPDATE players SET roster_assignment = $1 WHERE id = $2", [moverOldSlot, occupant.id]);
      }
      await client.query("UPDATE players SET roster_assignment = $1 WHERE id = $2", [targetSlot, playerId]);
    }
  });

  return getPlayersByTeam(teamId);
}

// Fills out a team's lines automatically by overall — best 2 goalies to
// G1/G2, best 6 defensemen to the 3 pairs, best 12 forwards to the 4 lines
// (matched to each slot's natural LW/C/RW label where enough depth exists at
// that position, falling back to next-best-overall-forward-of-any-position
// otherwise), then the next-best 5 skaters to SCRATCH. Everyone else is left
// at whatever they already had (MINORS by default). Used to give a brand
// new league a real lineup on day one instead of an all-MINORS empty grid —
// not exposed as a user action, since editing from there is what the Set
// Lineup tab is for.
async function autoSetLineup(teamId) {
  const players = await getPlayersByTeam(teamId);
  const byOverallDesc = (a, b) => b.overall - a.overall;

  const goalies = players.filter((p) => p.position === "G").sort(byOverallDesc);
  const defense = players.filter((p) => p.position === "D").sort(byOverallDesc);
  const forwards = players.filter((p) => p.position !== "G" && p.position !== "D");

  const used = new Set();
  const updates = [];
  const assign = (player, slot) => {
    updates.push({ id: player.id, slot });
    used.add(player.id);
  };

  LINEUP_SLOTS.filter((s) => s.group === "goalie")
    .sort((a, b) => a.line - b.line)
    .forEach((s, i) => goalies[i] && assign(goalies[i], s.slot));

  LINEUP_SLOTS.filter((s) => s.group === "defense").forEach((s, i) => defense[i] && assign(defense[i], s.slot));

  const forwardsByPosition = { C: [], LW: [], RW: [] };
  forwards
    .slice()
    .sort(byOverallDesc)
    .forEach((p) => (forwardsByPosition[p.position] ?? forwardsByPosition.C).push(p));
  LINEUP_SLOTS.filter((s) => s.group === "forward").forEach((s) => {
    let candidate = forwardsByPosition[s.positionLabel]?.find((p) => !used.has(p.id));
    if (!candidate) candidate = forwards.filter((p) => !used.has(p.id)).sort(byOverallDesc)[0];
    if (candidate) assign(candidate, s.slot);
  });

  [...forwards, ...defense]
    .filter((p) => !used.has(p.id))
    .sort(byOverallDesc)
    .slice(0, MAX_SCRATCHES)
    .forEach((p) => assign(p, SCRATCH_SLOT));

  await withTransaction(async (client) => {
    for (const u of updates) {
      await client.query("UPDATE players SET roster_assignment = $1 WHERE id = $2", [u.slot, u.id]);
    }
  });
}

// Only human teams matter here — CPU rosters are never synced into NHL 27,
// so a CPU-owned player never needs a "roster change" reviewed.
async function getRosterChanges() {
  const [teams, players] = await Promise.all([getTeams(), getPlayers()]);
  return teams
    .filter((t) => t.isHumanControlled)
    .map((team) => ({
      team,
      players: players
        .filter((p) => p.teamId === team.id && ["needs_update", "not_created"].includes(p.inGameStatus))
        .map((p) => ({ id: p.id, name: p.name, position: p.position, overall: p.overall, inGameStatus: p.inGameStatus })),
    }));
}

// Leaving `roster_update` (via the same universal Advance Phase action as
// every other phase): every pending change is now "applied" in NHL 27, so
// clear the flags, then generate the season's schedule now that rosters are
// actually final.
async function confirmRosterUpdate() {
  await pool.query("UPDATE players SET in_game_status = 'active' WHERE in_game_status IN ('needs_update', 'not_created')");
  return generateSeasonSchedule();
}

// --- Progression engine ---

function ageCurveRange(age) {
  if (age <= 21) return [2, 5];
  if (age <= 24) return [1, 3];
  if (age <= 26) return [0, 2];
  // 27+: growth mostly plateaus, matching potential's own age-27 plateau
  // (see resolvePotential). This baseline stays near zero on purpose —
  // performanceModifier (a strong season) is what drives any real movement
  // from here, rather than the age curve itself pushing a decline.
  return [-1, 1];
}

// Category-specific bias layered on top of the uniform age+performance delta,
// so growth/decline doesn't move every attribute in lockstep. Driven by age
// (career stage) and, for skaters, how much they actually played this season
// — reps build awareness and physicality regardless of career stage.
function skaterCategoryBias(category, age, experienceFactor) {
  let bias = 0;
  if (category === "senses" || category === "physical") {
    bias += 1.2 * experienceFactor;
  }
  if (age >= 28 && category === "skating") {
    const severity = age >= 33 ? 1.8 : age >= 30 ? 1.2 : 0.6;
    bias -= severity;
  }
  return bias;
}

// Young goalies lean on raw quickness; veterans compensate fading reflexes
// with positioning built from experience reading the play.
function goalieCategoryBias(category, age) {
  let bias = 0;
  if (category === "quickness") {
    if (age <= 26) bias += 1.5;
    else if (age >= 32) bias -= 1.5;
  }
  if (category === "positioning" && age >= 28) {
    bias += 1.3;
  }
  return bias;
}

function performanceModifier(player) {
  const gp = player.stats.gamesPlayed;
  if (gp === 0) return 0;

  if (player.position === "G") {
    const expectedSvPct = 0.895 + (player.overall - 70) * 0.0008;
    const diff = player.stats.savePercentage - expectedSvPct;
    return clamp(diff * 400, -3, 3);
  }

  const ppg = player.stats.points / gp;
  const expectedPpg = 0.15 + (player.overall - 60) * 0.012;
  const diff = ppg - expectedPpg;
  return clamp(diff * 12, -3, 3);
}

// Pure: computes a player's new age/overall/attributes/reset-stats without
// touching the database, so runProgression can batch the writes afterward.
function progressPlayer(player) {
  const previousOverall = player.overall;
  const previousAge = player.age;
  const [ageMin, ageMax] = ageCurveRange(player.age);
  const ageDelta = randInRange(ageMin, ageMax);
  const perfDelta = performanceModifier(player);
  const totalDelta = clamp(ageDelta + perfDelta, -8, 8);
  const newAge = player.age + 1;

  const attrList = player.position === "G" ? GOALIE_ATTRS : SKATER_ATTRS;
  const resetStats =
    player.position === "G"
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

  const isGoalie = player.position === "G";
  const attrCategory = isGoalie ? GOALIE_ATTR_CATEGORY : SKATER_ATTR_CATEGORY;
  const experienceFactor = clamp(player.stats.gamesPlayed / 15, 0, 1);

  const newAttributes = {};
  const attributeDeltas = {};
  attrList.forEach((attr) => {
    const category = attrCategory[attr];
    const bias = isGoalie
      ? goalieCategoryBias(category, player.age)
      : skaterCategoryBias(category, player.age, experienceFactor);
    const rawDelta = totalDelta + bias + randInRange(-1, 1);
    const oldVal = player.attributes[attr];
    const newVal = clamp(Math.round(oldVal + rawDelta), 25, 99);
    attributeDeltas[attr] = newVal - oldVal;
    newAttributes[attr] = newVal;
  });
  const newOverall = Math.round(mean(attrList.map((attr) => newAttributes[attr])));

  return {
    playerId: player.id,
    teamId: player.teamId,
    name: player.name,
    position: player.position,
    previousAge,
    newAge,
    previousOverall,
    newOverall,
    ovrDelta: newOverall - previousOverall,
    attributeDeltas,
    attributes: newAttributes,
    resetStats,
  };
}

async function runProgression() {
  const teams = await getTeams();
  const players = await getPlayers();
  const results = players.map(progressPlayer);

  await withTransaction(async (client) => {
    for (const r of results) {
      await client.query("UPDATE players SET age = $1, overall = $2, attributes = $3, stats = $4 WHERE id = $5", [
        r.newAge,
        r.newOverall,
        JSON.stringify(r.attributes),
        JSON.stringify(r.resetStats),
        r.playerId,
      ]);
    }
  });

  const flagged = results.filter((r) => Math.abs(r.ovrDelta) >= 2);
  const changeSheets = teams
    .filter((t) => t.isHumanControlled)
    .map((team) => ({
      teamId: team.id,
      city: team.city,
      name: team.name,
      players: flagged
        .filter((r) => r.teamId === team.id)
        .sort((a, b) => Math.abs(b.ovrDelta) - Math.abs(a.ovrDelta))
        .map((r) => ({
          playerId: r.playerId,
          name: r.name,
          position: r.position,
          previousAge: r.previousAge,
          newAge: r.newAge,
          previousOverall: r.previousOverall,
          newOverall: r.newOverall,
          ovrDelta: r.ovrDelta,
          attributeDeltas: r.attributeDeltas,
        })),
    }));

  const insertRes = await pool.query(
    `INSERT INTO progression_runs (total_players_progressed, total_flagged, change_sheets)
     VALUES ($1, $2, $3) RETURNING generated_at`,
    [results.length, flagged.length, JSON.stringify(changeSheets)]
  );

  return {
    generatedAt: insertRes.rows[0].generated_at,
    totalPlayersProgressed: results.length,
    totalFlagged: flagged.length,
    changeSheets,
  };
}

async function getLatestProgression() {
  const { rows } = await pool.query("SELECT * FROM progression_runs ORDER BY generated_at DESC LIMIT 1");
  if (rows.length === 0) return null;
  return {
    generatedAt: rows[0].generated_at,
    totalPlayersProgressed: rows[0].total_players_progressed,
    totalFlagged: rows[0].total_flagged,
    changeSheets: rows[0].change_sheets,
  };
}

// --- Draft picks ---
//
// Each pick's trade value is computed fresh on every read (never persisted)
// from the ORIGINAL team's projected draft slot, which is itself derived
// from that team's current strength — a blend of actual standings points%
// (the real mechanic, more trustworthy as the season goes on) and average
// roster overall (a stabler signal early, before the standings sample means
// much). current_team_id is who actually holds the pick right now (post
// trade); original_team_id is whose draft slot it represents and is what
// value is computed from — never changes once a pick is created.

// How much to trust actual standings vs. roster overall when projecting
// where a team will finish, based on how much of the season is in the books.
function standingsTrustWeight(gamesPlayed, gamesPerTeam) {
  if (!gamesPerTeam) return 0.2;
  return clamp(gamesPlayed / gamesPerTeam, 0.2, 0.8);
}

async function computeDraftOrder() {
  const [teams, players, standings, seasonInfo] = await Promise.all([
    getTeams(),
    getPlayers(),
    getStandings(),
    getSeasonInfo(),
  ]);

  const standingsByTeam = new Map(standings.map((s) => [s.teamId, s]));
  const gamesPerTeam = teams.length ? (seasonInfo.totalGames * 2) / teams.length : 0;

  const overallsByTeam = new Map(
    teams.map((t) => {
      const roster = players.filter((p) => p.teamId === t.id);
      const avgOverall = roster.length ? mean(roster.map((p) => p.overall)) : 70;
      return [t.id, avgOverall];
    })
  );
  const overallValues = [...overallsByTeam.values()];
  const minOverall = Math.min(...overallValues);
  const maxOverall = Math.max(...overallValues);

  const scored = teams.map((t) => {
    const standing = standingsByTeam.get(t.id);
    const pointsPct = standing && standing.gamesPlayed > 0 ? standing.points / (standing.gamesPlayed * 2) : 0.5;
    const avgOverall = overallsByTeam.get(t.id);
    const normalizedOverall = maxOverall > minOverall ? (avgOverall - minOverall) / (maxOverall - minOverall) : 0.5;
    const trustStandings = standingsTrustWeight(standing ? standing.gamesPlayed : 0, gamesPerTeam);
    // Lower strength = worse team = picks earlier, so a weak roster/points%
    // both push this DOWN (toward the front of the draft).
    const strength = trustStandings * pointsPct + (1 - trustStandings) * normalizedOverall;
    return { teamId: t.id, strength };
  });

  scored.sort((a, b) => a.strength - b.strength);
  const slotByTeamId = new Map(scored.map((s, idx) => [s.teamId, idx + 1]));
  const strengthByTeamId = new Map(scored.map((s) => [s.teamId, s.strength]));
  return { slotByTeamId, numTeams: teams.length, strengthByTeamId };
}

// --- Draft order override (post-playoff commissioner adjustment) ---
//
// Real NHL playoffs happen on the NHL 27 console, not in this app — the
// only playoff fact this app ever learns is who won it all (season_results,
// set via setPlayoffChampion). computeDraftOrder's live standings/roster
// projection has no idea a team even made the playoffs, let alone how far
// it went, so once the season's champion is known, the commissioner needs a
// way to hand-adjust the order to match what actually happened on the
// console. Absent an override row, getDraftOrder falls back to the
// projected order with the champion forced into last place — a reasonable
// starting point, not a guess at bracket results.

async function getDraftOrderOverride(seasonNumber) {
  const { rows } = await pool.query("SELECT team_id, position FROM draft_order WHERE season_number = $1", [
    seasonNumber,
  ]);
  if (rows.length === 0) return null;
  return new Map(rows.map((r) => [r.team_id, r.position]));
}

async function getDraftOrder(seasonNumber) {
  const teams = await getTeams();
  const override = await getDraftOrderOverride(seasonNumber);
  if (override) {
    const order = teams
      .map((t) => ({ position: override.get(t.id), team: t }))
      .sort((a, b) => a.position - b.position);
    return { seasonNumber, isCustom: true, order };
  }

  const { slotByTeamId } = await computeDraftOrder();
  let orderedTeams = teams.slice().sort((a, b) => slotByTeamId.get(a.id) - slotByTeamId.get(b.id));

  const { rows } = await pool.query("SELECT champion_team_id FROM season_results WHERE season_number = $1", [
    seasonNumber,
  ]);
  const championId = rows[0]?.champion_team_id ?? null;
  if (championId != null && orderedTeams.some((t) => t.id === championId)) {
    orderedTeams = [...orderedTeams.filter((t) => t.id !== championId), orderedTeams.find((t) => t.id === championId)];
  }

  const order = orderedTeams.map((team, idx) => ({ position: idx + 1, team }));
  return { seasonNumber, isCustom: false, order };
}

// Commissioner-only override of a single season's draft order — teamIds
// must be every team exactly once, and only for the season that's actually
// about to draft (or has just finished playoffs), since editing a past or
// distant-future season's order would be meaningless. Blocked once the
// draft has already started (current_pick_index > 0) so reordering can't
// retroactively rewrite picks that already happened.
async function setDraftOrder(seasonNumber, teamIds) {
  const teams = await getTeams();
  const validIds = new Set(teams.map((t) => t.id));
  if (
    !Array.isArray(teamIds) ||
    teamIds.length !== teams.length ||
    new Set(teamIds).size !== teams.length ||
    teamIds.some((id) => !validIds.has(id))
  ) {
    throw badRequest("Draft order must include every team exactly once");
  }

  const leaguePhase = await getLeaguePhase();
  if (leaguePhase.seasonNumber !== seasonNumber) {
    throw badRequest("Can only edit the draft order for the current season");
  }
  if (!["post_playoff_trade", "draft"].includes(leaguePhase.phase)) {
    throw badRequest("The draft order can only be edited once playoffs are done, up until the draft starts");
  }
  if (leaguePhase.phase === "draft") {
    const { rows } = await pool.query("SELECT current_pick_index FROM league_state WHERE id = 1");
    if (rows[0].current_pick_index > 0) {
      throw badRequest("Can't change the draft order once picks have been made");
    }
  }

  await withTransaction(async (client) => {
    await client.query("DELETE FROM draft_order WHERE season_number = $1", [seasonNumber]);
    for (let i = 0; i < teamIds.length; i++) {
      await client.query("INSERT INTO draft_order (season_number, team_id, position) VALUES ($1, $2, $3)", [
        seasonNumber,
        teamIds[i],
        i + 1,
      ]);
    }
  });

  return getDraftOrder(seasonNumber);
}

// --- CPU team needs (acquisition intelligence) ---
//
// A 0..1 "need" score per team per asset category — forwards, defense,
// goalies, draft picks — driving every CPU acquisition decision below (free
// agency targeting, which players a CPU shops for in its own trade offers,
// which of its own assets it's reluctant to give up, and how it judges an
// incoming human trade proposal). Roster needs are relative to the rest of
// THIS league's own talent (min-max normalized across the 8 teams), not an
// arbitrary absolute bar, matching how every other formula in this file
// (trade value, contract demand) is calibrated. Picks need reuses
// computeDraftOrder's own team-strength metric — a team already projected
// to finish near the bottom of the standings needs future assets more than
// a contender does, the same logic that puts them near the top of the
// actual draft order.

// Real dressed-roster size per group (see buildLineupSlots) — need is based
// on a team's top-N-by-overall at each position, not its whole organizational
// depth chart, so a team with a stacked NHL roster but thin AHL depth
// doesn't look needier than it actually is.
const NEED_ROSTER_SIZE = { forwards: 12, defense: 6, goalies: 2 };

function needGroupForPosition(position) {
  if (position === "G") return "goalies";
  if (position === "D") return "defense";
  return "forwards";
}

function topNOverallAverage(players, n) {
  if (players.length === 0) return 0;
  const sorted = players.slice().sort((a, b) => b.overall - a.overall);
  return mean(sorted.slice(0, Math.min(n, sorted.length)).map((p) => p.overall));
}

// Min-max normalizes value against every team's own value for the same
// metric, inverted so a WEAKER team (lower raw metric) gets a HIGHER need
// score. A flat league (every team identical) has no meaningful need
// signal, hence the 0.5 (neutral) fallback rather than a divide-by-zero.
function normalizedNeed(value, allValues) {
  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  if (max === min) return 0.5;
  return 1 - (value - min) / (max - min);
}

async function computeTeamNeeds() {
  const [teams, allPlayers, { strengthByTeamId }] = await Promise.all([
    getTeams(),
    getPlayers(),
    computeDraftOrder(),
  ]);

  const metricsByTeamId = new Map(
    teams.map((t) => {
      const roster = allPlayers.filter((p) => p.teamId === t.id);
      const metrics = {};
      for (const group of Object.keys(NEED_ROSTER_SIZE)) {
        const inGroup = roster.filter((p) => needGroupForPosition(p.position) === group);
        metrics[group] = topNOverallAverage(inGroup, NEED_ROSTER_SIZE[group]);
      }
      return [t.id, metrics];
    })
  );

  const needsByTeamId = new Map();
  for (const t of teams) {
    const needs = {};
    for (const group of Object.keys(NEED_ROSTER_SIZE)) {
      const allValues = teams.map((other) => metricsByTeamId.get(other.id)[group]);
      needs[group] = normalizedNeed(metricsByTeamId.get(t.id)[group], allValues);
    }
    const allStrengths = teams.map((other) => strengthByTeamId.get(other.id));
    needs.picks = normalizedNeed(strengthByTeamId.get(t.id), allStrengths);
    needsByTeamId.set(t.id, needs);
  }
  return needsByTeamId;
}

// Same 5-tier scale as tradeInterestLevel's Not/Slightly/Very/Highly split —
// human-facing need is shown as a label, never the raw 0..1 score, since
// the score's only real meaning is its rank against the other 7 teams, not
// an absolute number a GM should be reading like a percentage.
function needLevelLabel(score) {
  if (score >= 0.8) return "Very High";
  if (score >= 0.6) return "High";
  if (score >= 0.4) return "Moderate";
  if (score >= 0.2) return "Low";
  return "Very Low";
}

async function getTeamNeeds(teamId) {
  const needsByTeamId = await computeTeamNeeds();
  const needs = needsByTeamId.get(teamId);
  if (!needs) throw notFound(`Team ${teamId} not found`);
  return {
    forwards: needLevelLabel(needs.forwards),
    defense: needLevelLabel(needs.defense),
    goalies: needLevelLabel(needs.goalies),
    picks: needLevelLabel(needs.picks),
  };
}

// How much a category's need score inflates that asset's effective value in
// a CPU's own eyes — an asset in a category the CPU badly needs is worth
// MORE to receive (an incoming player at 1.0 need is worth up to 2.5x its
// raw trade value) and MORE to give up (the CPU is that much more reluctant
// to part with it). Same multiplier drives both directions, so it's the
// RELATIVE gap between a CPU's need for what it's getting vs. what it's
// giving up that actually moves behavior, not the absolute number.
const NEED_VALUE_WEIGHT = 1.5;
function needValueMultiplier(need) {
  return 1 + need * NEED_VALUE_WEIGHT;
}

function sumNeedsAdjustedValue(playerIds, pickIds, playersById, picksById, teamNeeds) {
  const playerTotal = playerIds.reduce((sum, id) => {
    const p = playersById.get(id);
    if (!p) return sum;
    return sum + discountedAssetValue(p.tradeValue) * needValueMultiplier(teamNeeds[needGroupForPosition(p.position)]);
  }, 0);
  const pickTotal = pickIds.reduce((sum, id) => {
    const pk = picksById.get(id);
    if (!pk) return sum;
    return sum + discountedAssetValue(pk.tradeValue) * needValueMultiplier(teamNeeds.picks);
  }, 0);
  return playerTotal + pickTotal;
}

// Exponential decay calibrated so pick 1 overall sits at the top of the
// scale, and value drops fast enough that round 4's first pick lands right
// around 3 (matching the "very low, ~3-1 by round 4" instruction) — decay
// continues within a round too, not just across round boundaries, so "the
// picks after 1st" fall off immediately rather than only at round breaks.
function draftPickTradeValue(round, positionInRound, numTeams) {
  const x = round - 1 + (positionInRound - 1) / numTeams;
  const raw = 20 * Math.pow(0.531, x);
  return clamp(Math.round(raw), 1, 20);
}

function mapDraftPickRow(row, teamsById, slotByTeamId, numTeams) {
  const positionInRound = slotByTeamId.get(row.original_team_id) ?? 1;
  const overallPickNumber = (row.round - 1) * numTeams + positionInRound;
  return {
    id: row.id,
    seasonNumber: row.season_number,
    round: row.round,
    positionInRound,
    overallPickNumber,
    tradeValue: draftPickTradeValue(row.round, positionInRound, numTeams),
    originalTeam: teamsById.get(row.original_team_id),
    currentTeam: teamsById.get(row.current_team_id),
  };
}

// How many upcoming draft classes are tradeable at once (this season's
// picks plus the next couple years'), mirroring how real NHL trades work —
// GMs deal in "our 2029 2nd" long before that draft happens.
const DRAFT_TRADE_WINDOW = 3;

// seasonNumber explicitly narrows to one draft class (used for the actual
// draft-day order, which only ever means the season currently drafting).
// Left off, this returns every pick currently open for trading — the
// current season's through DRAFT_TRADE_WINDOW - 1 years out. Picks aren't
// deleted once a season moves on (see generateDraftPicksForSeason's
// comment), so old seasons stay in the table and must be filtered either
// way, single-season or windowed.
async function getDraftPicks({ teamId, seasonNumber } = {}) {
  const [teamsById, { slotByTeamId, numTeams }, season] = await Promise.all([
    getTeamsById(),
    computeDraftOrder(),
    getSeasonInfo(),
  ]);

  const params = [];
  let seasonClause;
  if (seasonNumber) {
    params.push(seasonNumber);
    seasonClause = `season_number = $${params.length}`;
  } else {
    params.push(season.seasonNumber, season.seasonNumber + DRAFT_TRADE_WINDOW - 1);
    seasonClause = `season_number BETWEEN $${params.length - 1} AND $${params.length}`;
  }

  let text = `SELECT * FROM draft_picks WHERE ${seasonClause}`;
  if (teamId) {
    params.push(teamId);
    text += ` AND current_team_id = $${params.length}`;
  }
  text += " ORDER BY season_number, round, id";

  const { rows } = await pool.query(text, params);

  // A season with a commissioner-saved draft_order override (see
  // getDraftOrder/setDraftOrder above) uses that instead of the live
  // projection for every pick in that season — everything else still falls
  // back to the shared computed default, unchanged from before overrides
  // existed.
  const seasonNumbers = [...new Set(rows.map((r) => r.season_number))];
  const overridesBySeasonNumber = new Map(
    await Promise.all(seasonNumbers.map(async (sn) => [sn, await getDraftOrderOverride(sn)]))
  );

  return rows.map((row) => {
    const rowSlotByTeamId = overridesBySeasonNumber.get(row.season_number) ?? slotByTeamId;
    return mapDraftPickRow(row, teamsById, rowSlotByTeamId, numTeams);
  });
}

const DRAFT_ROUNDS = 7;

// Wipes and regenerates every pick for a season — same "no history archive"
// tradeoff as the schedule generator (see generateSeasonSchedule): once a
// season's draft actually happens, its used picks aren't kept around, since
// there's no draft-day interface yet that consumes them.
async function generateDraftPicksForSeason(seasonNumber) {
  const teams = await getTeams();
  await withTransaction(async (client) => {
    await client.query("DELETE FROM draft_picks WHERE season_number = $1", [seasonNumber]);
    for (let round = 1; round <= DRAFT_ROUNDS; round++) {
      for (const team of teams) {
        await client.query(
          "INSERT INTO draft_picks (season_number, round, original_team_id, current_team_id) VALUES ($1, $2, $3, $3)",
          [seasonNumber, round, team.id]
        );
      }
    }
  });
}

// Keeps DRAFT_TRADE_WINDOW draft classes generated starting at seasonNumber
// at all times — called wherever picks get (re)generated (initial seed,
// roster import, season loop-around) instead of generateDraftPicksForSeason
// directly, so GMs always have a season's worth of future years to trade.
// Only fills in seasons that don't exist yet; a season whose picks already
// exist (including ones already spent in a draft or moved in a trade) is
// left completely alone, since draft_picks rows are never deleted once
// created.
async function ensureDraftPicksThroughWindow(seasonNumber) {
  const targetSeason = seasonNumber + DRAFT_TRADE_WINDOW - 1;
  const { rows } = await pool.query(
    "SELECT DISTINCT season_number FROM draft_picks WHERE season_number BETWEEN $1 AND $2",
    [seasonNumber, targetSeason]
  );
  const existing = new Set(rows.map((r) => r.season_number));
  for (let s = seasonNumber; s <= targetSeason; s++) {
    if (!existing.has(s)) {
      await generateDraftPicksForSeason(s);
    }
  }
}

// --- Notifications ---
//
// Written only by round-resolution functions (never by the submit-side
// actions) — this is a feed of outcomes, not a log of everything a team
// did. See MyGM's Notifications tab on the client.

async function createNotification(teamId, message, outcome = "success") {
  await pool.query("INSERT INTO notifications (team_id, message, outcome) VALUES ($1, $2, $3)", [teamId, message, outcome]);
}

async function getNotifications(teamId) {
  const { rows } = await pool.query(
    "SELECT * FROM notifications WHERE team_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100",
    [teamId]
  );
  return rows.map((r) => ({ id: r.id, message: r.message, outcome: r.outcome, createdAt: r.created_at, read: r.read }));
}

async function getUnreadNotificationCount(teamId) {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM notifications WHERE team_id = $1 AND read = false", [
    teamId,
  ]);
  return rows[0].count;
}

async function markNotificationsRead(teamId) {
  await pool.query("UPDATE notifications SET read = true WHERE team_id = $1 AND read = false", [teamId]);
  return getNotifications(teamId);
}

// Every team's notifications merged into one public, league-wide feed —
// unlike getNotifications (privacy-scoped to one team), this backs the
// League tab's "Transactions" page and deliberately includes every team's
// events, both completed moves and failed ones (outbid, rejected offer,
// trade that fell through), since a real league transactions page shows the
// whole league's activity, not just your own.
async function getLeagueTransactions(limit = 200) {
  const [teamsById, { rows }] = await Promise.all([
    getTeamsById(),
    pool.query("SELECT * FROM notifications ORDER BY created_at DESC, id DESC LIMIT $1", [limit]),
  ]);
  return rows.map((r) => ({
    id: r.id,
    team: teamsById.get(r.team_id),
    message: r.message,
    outcome: r.outcome,
    createdAt: r.created_at,
  }));
}

// --- Users / auth ---
//
// Username-based (not email — this is a private friend league, invite-only,
// not a public signup product). Accounts are created via
// server/scripts/createUser.js, not a public registration endpoint, until a
// real login/session flow exists on top of this. password_hash never leaves
// this module — mapUserRow strips it before any row reaches a route handler.
const BCRYPT_ROUNDS = 10;

const USER_ROLES = ["user", "commissioner"];

function mapUserRow(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    teamId: row.team_id,
    role: row.role,
    createdAt: row.created_at,
  };
}

async function createUser({ username, password, displayName, teamId = null, role = "user" }) {
  if (!username || !password || !displayName) {
    throw badRequest("username, password, and displayName are all required");
  }
  if (!USER_ROLES.includes(role)) {
    throw badRequest(`role must be one of ${USER_ROLES.join(", ")}`);
  }
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  try {
    return await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO users (username, password_hash, display_name, team_id, role)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [username, passwordHash, displayName, teamId, role]
      );
      if (teamId != null) {
        // Handing a team a login makes it human-controlled from here on —
        // a CPU team the commissioner just assigned a GM to should
        // immediately stop taking CPU free-agency/trade actions and open up
        // to human-only routes, not silently stay CPU until someone
        // remembers to flip the flag separately. A no-op UPDATE if the team
        // was already human-controlled.
        await client.query("UPDATE teams SET is_human_controlled = true WHERE id = $1", [teamId]);
      }
      return mapUserRow(rows[0]);
    });
  } catch (err) {
    if (err.code === "23505") {
      throw badRequest(`Username "${username}" is already taken`);
    }
    throw err;
  }
}

async function getUserById(id) {
  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
  return rows.length ? mapUserRow(rows[0]) : null;
}

async function getUsers() {
  const { rows } = await pool.query("SELECT * FROM users ORDER BY id ASC");
  return rows.map(mapUserRow);
}

// Guards against the two ways this could strand the league: deleting the
// session's own account (locks the commissioner out mid-click, before
// they've had a chance to log back in as someone else) and deleting the
// last remaining commissioner (nobody left who could create a replacement
// account or undo it). Neither check applies to a normal user's deletion.
async function deleteUser(id, { requestingUserId } = {}) {
  if (id === requestingUserId) {
    throw badRequest("You can't delete the account you're currently logged in as");
  }
  const target = await getUserById(id);
  if (!target) {
    throw notFound("User not found");
  }
  if (target.role === "commissioner") {
    const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'commissioner'");
    if (rows[0].count <= 1) {
      throw badRequest("Can't delete the only commissioner account — make another account a commissioner first");
    }
  }
  await withTransaction(async (client) => {
    await client.query("DELETE FROM users WHERE id = $1", [id]);
    if (target.teamId != null) {
      // Mirrors createUser's opposite flip: a team only stays
      // human-controlled while at least one login is actually assigned to
      // it. Removing the last one hands it back to the CPU rather than
      // leaving it orphaned as "human-controlled" with nobody GMing it.
      const { rows } = await client.query("SELECT COUNT(*)::int AS count FROM users WHERE team_id = $1", [target.teamId]);
      if (rows[0].count === 0) {
        await client.query("UPDATE teams SET is_human_controlled = false WHERE id = $1", [target.teamId]);
      }
    }
  });
  return { deleted: true, id };
}

// Returns the safe (no password_hash) user object on a correct
// username/password match, or null otherwise — never throws on bad
// credentials, since "wrong password" isn't a server error.
async function verifyLogin(username, password) {
  const { rows } = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
  if (rows.length === 0) return null;
  const row = rows[0];
  const matches = await bcrypt.compare(password, row.password_hash);
  return matches ? mapUserRow(row) : null;
}

// --- Free agency ---
//
// An unsigned player is just a `players` row with `team_id = NULL` (see
// schema.sql) — the pool is populated by contracts expiring at the
// season-loop-around (build slice 7), not generated separately. This slice
// only builds the bidding/resolution mechanics themselves.

async function getFreeAgents() {
  const { rows } = await pool.query("SELECT * FROM players WHERE team_id IS NULL ORDER BY overall DESC");
  return rows.map(mapPlayerRow);
}

// How much AAV a bid needs to be acceptable, given the player's own
// contractDemand as the "ideal" years/AAV pair. Deviating from their ideal
// term length in EITHER direction (more years OR fewer) raises the bar —
// per the user's explicit rule, this isn't a real-world "term for dollars"
// trade-off, both directions cost the offering team more.
const YEARS_DEVIATION_PENALTY = 0.06; // +6% required AAV per year away from their ask, either direction

function requiredAav(player, offeredYears) {
  const demand = player.contractDemand;
  const deviation = Math.abs(offeredYears - demand.yearsRequested);
  return demand.aavMillions * (1 + YEARS_DEVIATION_PENALTY * deviation);
}

async function submitFreeAgentBid({ teamId, playerId, aavMillions, years }) {
  if (!Number.isFinite(aavMillions) || aavMillions <= 0) throw badRequest("aavMillions must be a positive number");
  if (!Number.isInteger(years) || years <= 0) throw badRequest("years must be a positive integer");

  const leaguePhase = await getLeaguePhase();
  if (!["free_agency", "trade_period"].includes(leaguePhase.phase)) {
    throw badRequest(`Free agency bidding isn't open during the '${leaguePhase.phase}' phase`);
  }

  const [teams, players] = await Promise.all([getTeams(), getPlayers()]);
  const team = teams.find((t) => t.id === teamId);
  if (!team) throw notFound(`Team ${teamId} not found`);
  if (!team.isHumanControlled) throw badRequest("Only human-controlled teams can submit free agency bids");

  const player = players.find((p) => p.id === playerId);
  if (!player) throw notFound(`Player ${playerId} not found`);
  if (player.teamId !== null) throw badRequest(`${player.name} is not a free agent`);

  const capSummary = await getTeamCapSummary(teamId);
  if (capSummary.committed + aavMillions > capSummary.ceiling) {
    throw badRequest(
      `That bid would put ${team.city} ${team.name} over the salary cap — only $${Math.max(0, capSummary.space).toFixed(3)}M of space available.`
    );
  }

  await upsertFreeAgentBid(leaguePhase.seasonNumber, leaguePhase.phaseRound, playerId, teamId, aavMillions, years);

  return getFreeAgencyBoard(teamId);
}

// Board scoped to one team — free agents plus *that team's own* bid on each
// (never other teams' bids: real GMs don't see competing sealed offers, so
// neither should this). teamId is optional only so the very first "who am
// I" render before a team is picked doesn't error; every real caller passes
// one.
async function getFreeAgencyBoard(teamId) {
  const [leaguePhase, freeAgents, players, teamsById] = await Promise.all([
    getLeaguePhase(),
    getFreeAgents(),
    getPlayers(),
    getTeamsById(),
  ]);

  // Bids only ever exist for the round they were placed in, and round
  // numbers aren't unique across phases — only join them in while bidding
  // is actually open, otherwise a stale round number could pull in bids
  // left over from an unrelated phase.
  const biddingOpen = ["free_agency", "trade_period"].includes(leaguePhase.phase);
  const yourBidByPlayer = new Map();
  if (biddingOpen && teamId != null) {
    const { rows: bidRows } = await pool.query(
      "SELECT * FROM free_agent_bids WHERE season_number = $1 AND round = $2 AND team_id = $3",
      [leaguePhase.seasonNumber, leaguePhase.phaseRound, teamId]
    );
    bidRows.forEach((b) => yourBidByPlayer.set(b.player_id, { aavMillions: Number(b.aav_millions), years: b.years }));
  }

  // Players still on a roster whose contract is about to lapse — not
  // actually free agents yet (their own team can still re-sign them during
  // the resigning phase), just a heads-up preview of who might hit the
  // market next, viewable in any phase.
  const expiringSoon = players
    .filter((p) => p.teamId !== null && p.contractYearsLeft <= 1)
    .map((p) => ({ ...p, team: teamsById.get(p.teamId) }));

  return {
    seasonNumber: leaguePhase.seasonNumber,
    round: leaguePhase.phaseRound,
    phase: leaguePhase.phase,
    biddingOpen,
    freeAgents: freeAgents.map((p) => ({ ...p, yourBid: yourBidByPlayer.get(p.id) ?? null })),
    expiringSoon,
  };
}

// Resolves one round: for each contested free agent, only bids that clear
// requiredAav() are eligible, and among those the highest AAV wins (ties
// broken by total contract value, then earliest bid) PROVIDED that team
// actually has the cap room — a technically-winning bid that would blow a
// team's books gets skipped in favor of the next-best acceptable bid, same
// as if it had lost the auction outright. Unsigned free agents simply carry
// over into the pool for the next round — bids themselves are NOT carried
// forward, each round is a fresh set of offers.
//
// Players are resolved highest-bid-first (not DB/insertion order) so a
// team's limited cap space gets claimed by its most competitive pursuit
// first, not whichever player happened to be processed first — the same
// reasoning resolveTradeProposals already sorts by offered_value DESC for.
// This is still a per-player greedy pass, not a true global optimization
// across a team's whole slate of bids that round — a real GM might have
// preferred a different combination, but solving that exactly is a much
// bigger problem than this needs to be.
async function resolveFreeAgencyRound(seasonNumber, round) {
  const [{ rows: bidRows }, players, teamsById] = await Promise.all([
    pool.query("SELECT * FROM free_agent_bids WHERE season_number = $1 AND round = $2", [seasonNumber, round]),
    getPlayers(),
    getTeamsById(),
  ]);
  if (bidRows.length === 0) return { signings: [] };

  const playersById = new Map(players.map((p) => [p.id, p]));
  const bidsByPlayer = new Map();
  bidRows.forEach((b) => {
    const list = bidsByPlayer.get(b.player_id) ?? [];
    list.push({ teamId: b.team_id, aavMillions: Number(b.aav_millions), years: b.years, id: b.id });
    bidsByPlayer.set(b.player_id, list);
  });

  const orderedPlayerIds = [...bidsByPlayer.keys()].sort((a, b) => {
    const maxA = Math.max(...bidsByPlayer.get(a).map((x) => x.aavMillions));
    const maxB = Math.max(...bidsByPlayer.get(b).map((x) => x.aavMillions));
    return maxB - maxA;
  });

  const ceiling = getCapCeiling(seasonNumber);
  const runningCapByTeam = new Map();
  const getRunningCap = async (teamId) => {
    if (!runningCapByTeam.has(teamId)) runningCapByTeam.set(teamId, await getTeamCapHit(teamId));
    return runningCapByTeam.get(teamId);
  };

  const signings = [];
  await withTransaction(async (client) => {
    for (const playerId of orderedPlayerIds) {
      const bids = bidsByPlayer.get(playerId);
      const player = playersById.get(playerId);
      if (!player || player.teamId !== null) continue; // already signed earlier this same batch/round, shouldn't happen but stay safe

      const acceptable = bids.filter((b) => b.aavMillions >= requiredAav(player, b.years));
      if (acceptable.length === 0) {
        for (const b of bids) {
          await createNotification(
            b.teamId,
            `Your offer for ${player.name} ($${b.aavMillions.toFixed(3)}M / ${b.years}yr) was too low and was rejected.`,
            "failure"
          );
        }
        continue;
      }

      acceptable.sort(
        (a, b) => b.aavMillions - a.aavMillions || b.aavMillions * b.years - a.aavMillions * a.years || a.id - b.id
      );

      let winner = null;
      for (const candidate of acceptable) {
        const teamCap = await getRunningCap(candidate.teamId);
        if (teamCap + candidate.aavMillions <= ceiling) {
          winner = candidate;
          break;
        }
      }

      if (!winner) {
        for (const b of bids) {
          await createNotification(
            b.teamId,
            `Your offer for ${player.name} ($${b.aavMillions.toFixed(3)}M / ${b.years}yr) fell through — no bidder had the cap space to complete it.`,
            "failure"
          );
        }
        continue;
      }

      await client.query(
        `UPDATE players SET team_id = $1, cap_hit = $2, contract_years_left = $3, in_game_status = 'needs_update'
         WHERE id = $4`,
        [winner.teamId, winner.aavMillions, winner.years, playerId]
      );
      runningCapByTeam.set(winner.teamId, (await getRunningCap(winner.teamId)) + winner.aavMillions);
      signings.push({ playerId, playerName: player.name, teamId: winner.teamId, aavMillions: winner.aavMillions, years: winner.years });

      await createNotification(
        winner.teamId,
        `Signed ${player.name} — $${winner.aavMillions.toFixed(3)}M / ${winner.years}yr.`
      );
      for (const b of bids) {
        if (b.id === winner.id) continue;
        await createNotification(
          b.teamId,
          `Lost bidding for ${player.name} to ${teamsById.get(winner.teamId)?.abbr ?? "another team"}.`,
          "failure"
        );
      }
    }
  });

  return { signings };
}

// --- Re-signing ---
//
// Reuses free_agent_bids and requiredAav from free agency, just scoped
// differently: only a player's own current (human) team may make an offer
// — this is exclusive incumbent negotiation, not an open market, so there's
// never more than one team's bid to compare per player. season_number and
// round already come from the same league_state columns free agency uses,
// and a resigning-phase round number never collides with a free-agency
// round from the same pass through the season, so no extra "phase" column
// is needed on the shared table.

async function getResigningBoard() {
  const leaguePhase = await getLeaguePhase();
  const [teams, players] = await Promise.all([getTeams(), getPlayers()]);
  const teamsById = new Map(teams.map((t) => [t.id, t]));
  const eligible = players.filter(
    (p) => p.teamId !== null && teamsById.get(p.teamId).isHumanControlled && p.contractYearsLeft <= 1
  );

  // Same round-number-isn't-globally-unique caveat as getFreeAgencyBoard —
  // only join in offers while the resigning phase (and thus this round
  // number) actually refers to resigning offers.
  const resigningOpen = leaguePhase.phase === "resigning";
  const bidByPlayer = new Map();
  if (resigningOpen) {
    const { rows: bidRows } = await pool.query(
      "SELECT * FROM free_agent_bids WHERE season_number = $1 AND round = $2",
      [leaguePhase.seasonNumber, leaguePhase.phaseRound]
    );
    bidRows.forEach((b) => bidByPlayer.set(b.player_id, b));
  }

  return {
    seasonNumber: leaguePhase.seasonNumber,
    round: leaguePhase.phaseRound,
    phase: leaguePhase.phase,
    resigningOpen,
    players: eligible.map((p) => ({
      ...p,
      team: teamsById.get(p.teamId),
      currentOffer: bidByPlayer.has(p.id)
        ? { aavMillions: Number(bidByPlayer.get(p.id).aav_millions), years: bidByPlayer.get(p.id).years }
        : null,
    })),
  };
}

async function submitResignOffer({ teamId, playerId, aavMillions, years }) {
  if (!Number.isFinite(aavMillions) || aavMillions <= 0) throw badRequest("aavMillions must be a positive number");
  if (!Number.isInteger(years) || years <= 0) throw badRequest("years must be a positive integer");

  const leaguePhase = await getLeaguePhase();
  if (leaguePhase.phase !== "resigning") {
    throw badRequest(`Re-signing offers aren't open during the '${leaguePhase.phase}' phase`);
  }

  const [teams, players] = await Promise.all([getTeams(), getPlayers()]);
  const team = teams.find((t) => t.id === teamId);
  if (!team) throw notFound(`Team ${teamId} not found`);
  if (!team.isHumanControlled) throw badRequest("Only human-controlled teams can re-sign players");

  const player = players.find((p) => p.id === playerId);
  if (!player) throw notFound(`Player ${playerId} not found`);
  if (player.teamId !== teamId) throw badRequest(`${player.name} is not on your roster`);
  if (player.contractYearsLeft > 1) throw badRequest(`${player.name}'s contract isn't expiring yet`);

  // Room for this deal is the team's cap space with the player's OLD cap
  // contribution backed out first — they're already on the books at that
  // number (0 if they're currently in the minors), so only the delta (new
  // ask vs. current contribution) actually has to fit.
  const capSummary = await getTeamCapSummary(teamId);
  const spaceForThisDeal = capSummary.ceiling - (capSummary.committed - capContribution(player));
  if (aavMillions > spaceForThisDeal) {
    throw badRequest(
      `That offer would put ${team.city} ${team.name} over the salary cap — only $${Math.max(0, spaceForThisDeal).toFixed(3)}M of space available for this deal.`
    );
  }

  await upsertFreeAgentBid(leaguePhase.seasonNumber, leaguePhase.phaseRound, playerId, teamId, aavMillions, years);

  return getResigningBoard();
}

// Unlike resolveFreeAgencyRound there's never a competing bid to pick a
// winner from — only the player's own team can ever offer, so this is
// just "did their one offer clear the bar."
//
// contract_years_left is set to `years + 1`, not `years` — see the +1 note
// on the contract-expiry sweep in advanceLeaguePhase's wraparound branch,
// which always decrements every rostered contract by exactly one once per
// trip through this phase. A deal signed here hasn't had any of its
// seasons "used" yet (unlike a contract carried over from before), so this
// cancels that decrement out to land on the real agreed term.
async function resolveResigningRound(seasonNumber, round) {
  const [{ rows: bidRows }, players] = await Promise.all([
    pool.query("SELECT * FROM free_agent_bids WHERE season_number = $1 AND round = $2", [seasonNumber, round]),
    getPlayers(),
  ]);
  if (bidRows.length === 0) return { signings: [] };

  const playersById = new Map(players.map((p) => [p.id, p]));
  const signings = [];
  const ceiling = getCapCeiling(seasonNumber);
  const runningCapByTeam = new Map();
  const getRunningCap = async (teamId) => {
    if (!runningCapByTeam.has(teamId)) runningCapByTeam.set(teamId, await getTeamCapHit(teamId));
    return runningCapByTeam.get(teamId);
  };

  await withTransaction(async (client) => {
    for (const bid of bidRows) {
      const player = playersById.get(bid.player_id);
      if (!player || player.teamId !== bid.team_id) continue; // only the player's own team's offer ever counts
      const aavMillions = Number(bid.aav_millions);
      if (aavMillions < requiredAav(player, bid.years)) {
        await createNotification(
          bid.team_id,
          `Your re-signing offer for ${player.name} ($${aavMillions.toFixed(3)}M / ${bid.years}yr) was too low and was rejected — they'll hit free agency.`,
          "failure"
        );
        continue; // offer lapses, unsigned
      }

      // Same "back out the player's old cap hit first" math as
      // submitResignOffer's up-front check, but authoritative here — a team
      // that signed several deals earlier this same round has less room
      // left than it did at submission time.
      const teamCap = await getRunningCap(bid.team_id);
      const projected = teamCap - capContribution(player) + aavMillions;
      if (projected > ceiling) {
        await createNotification(
          bid.team_id,
          `Your re-signing offer for ${player.name} ($${aavMillions.toFixed(3)}M / ${bid.years}yr) would have put you over the salary cap and was rejected — they'll hit free agency.`,
          "failure"
        );
        continue;
      }
      runningCapByTeam.set(bid.team_id, projected);

      await client.query("UPDATE players SET cap_hit = $1, contract_years_left = $2 WHERE id = $3", [
        aavMillions,
        bid.years + 1,
        player.id,
      ]);
      signings.push({ playerId: player.id, playerName: player.name, aavMillions, years: bid.years });
      await createNotification(bid.team_id, `Re-signed ${player.name} — $${aavMillions.toFixed(3)}M / ${bid.years}yr.`);
    }
  });

  return { signings };
}

// --- CPU GM intelligence ---
//
// CPU teams were explicitly passive in free agency and re-signing when the
// season-phase machine first shipped (documented as a deliberate scope cut,
// "revisit later"). This is that revisit. A CPU offer is just another row
// inserted into free_agent_bids before the round resolves — resolveFreeAgencyRound
// and resolveResigningRound need no changes at all, since they already treat
// every bid identically regardless of who placed it.
//
// Every CPU offer is priced directly off the target player's own
// contractDemand (their exact ask), which by construction always clears
// requiredAav (zero years-deviation, so the bar equals the ask itself) —
// a small random premium is layered on top only so CPU offers aren't all
// identical and can occasionally outbid a human's lowball. Cap-aware (a CPU
// team won't generate a bid it can't afford, tracked via a running total
// across its own targets so it doesn't "afford" several unaffordable-
// together bids on paper) but still not fit/position-aware; it's a second
// pass at "CPU teams participate for real," not a full GM simulation.
const CPU_FA_TARGETS_PER_ROUND = 3; // how many free agents each CPU team bids on per round
// Minimum premium is 1.08, not 1.0 — computeContractDemand rerolls
// yearsRequested randomly (1 or 2) for age-34+ players on every read, so
// the same player's "ask" can differ between when a CPU bid is generated
// and when it's later validated at round-resolution. requiredAav's penalty
// for a 1-year mismatch is +6%; a >=8% floor absorbs that worst case
// so a CPU offer can never be spuriously rejected by its own target's
// clock re-rolling out from under it. Found via a real rejected re-sign
// offer during verification, not a hypothetical.
const CPU_FA_PREMIUM_RANGE = [1.08, 1.2];
const CPU_RESIGN_PREMIUM_RANGE = [1.08, 1.15];
const CPU_RESIGN_SKIP_CHANCE = 0.15; // lets some expiring CPU players actually hit the open market instead of every contract auto-renewing

function randomInRange([min, max]) {
  return min + Math.random() * (max - min);
}

// Weighted-without-replacement pick of a CPU team's bidding targets for the
// round — favors higher overall without being an exclusive "best player
// available" pick, so multiple CPU teams (and humans) realistically end up
// competing for the same top free agents some rounds and not others. Also
// favors whichever position group the team actually needs — a team stacked
// at forward won't chase another one just because it's the best player on
// the board, while a team thin at goalie or defense skews its targets that
// way even at a lower raw overall.
function pickCpuFreeAgentTargets(freeAgents, count, teamNeeds) {
  return weightedSampleWithoutReplacement(
    freeAgents,
    count,
    (p) => Math.max(1, p.overall) ** 2 * needValueMultiplier(teamNeeds[needGroupForPosition(p.position)])
  );
}

async function upsertFreeAgentBid(seasonNumber, round, playerId, teamId, aavMillions, years) {
  await pool.query(
    `INSERT INTO free_agent_bids (season_number, round, player_id, team_id, aav_millions, years)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (season_number, round, player_id, team_id)
     DO UPDATE SET aav_millions = EXCLUDED.aav_millions, years = EXCLUDED.years`,
    [seasonNumber, round, playerId, teamId, aavMillions, years]
  );
}

async function generateCpuFreeAgentBids(seasonNumber, round) {
  const [teams, freeAgents] = await Promise.all([getTeams(), getFreeAgents()]);
  const cpuTeams = teams.filter((t) => !t.isHumanControlled);
  if (cpuTeams.length === 0 || freeAgents.length === 0) return;

  const needsByTeamId = await computeTeamNeeds();
  const ceiling = getCapCeiling(seasonNumber);
  for (const team of cpuTeams) {
    const teamNeeds = needsByTeamId.get(team.id);
    const targets = pickCpuFreeAgentTargets(freeAgents, CPU_FA_TARGETS_PER_ROUND, teamNeeds);
    let projectedCap = await getTeamCapHit(team.id);
    for (const player of targets) {
      const years = player.contractDemand.yearsRequested;
      // A modest extra premium on top of the usual random range when this
      // position is a real need — a desperate team pays a little more, not
      // just chases the position more often.
      const need = teamNeeds[needGroupForPosition(player.position)];
      const aavMillions =
        Math.round(player.contractDemand.aavMillions * randomInRange(CPU_FA_PREMIUM_RANGE) * (1 + need * 0.1) * 1000) /
        1000;
      if (projectedCap + aavMillions > ceiling) continue; // can't afford it, don't bother bidding
      await upsertFreeAgentBid(seasonNumber, round, player.id, team.id, aavMillions, years);
      projectedCap += aavMillions;
    }
  }
}

async function generateCpuResignOffers(seasonNumber, round) {
  const teams = await getTeams();
  const cpuTeams = teams.filter((t) => !t.isHumanControlled);
  if (cpuTeams.length === 0) return;

  const ceiling = getCapCeiling(seasonNumber);
  for (const team of cpuTeams) {
    const roster = await getPlayersByTeam(team.id);
    const expiring = roster.filter((p) => p.contractYearsLeft <= 1);
    let projectedCap = await getTeamCapHit(team.id); // already includes expiring players' OLD cap hits
    for (const player of expiring) {
      if (Math.random() < CPU_RESIGN_SKIP_CHANCE) continue; // lets them walk to free agency instead
      const years = player.contractDemand.yearsRequested;
      const aavMillions =
        Math.round(player.contractDemand.aavMillions * randomInRange(CPU_RESIGN_PREMIUM_RANGE) * 1000) / 1000;
      const withoutOldHit = projectedCap - capContribution(player);
      if (withoutOldHit + aavMillions > ceiling) continue; // can't afford to keep them — let them walk instead
      await upsertFreeAgentBid(seasonNumber, round, player.id, team.id, aavMillions, years);
      projectedCap = withoutOldHit + aavMillions;
    }
  }
}

// --- Draft prospects ---
//
// A fresh pool of draft-eligible 18-year-olds is generated per season (or
// imported by the user). Every prospect carries full hidden attributes and
// potential, exactly like a real player, so a future "select prospect" step
// can turn one directly into a players row — but the public draft board
// (mapProspectRow, below) never exposes overall/potential/attributes, only
// name/position/nationality/height/weight/prospect_rank.

const PROSPECT_NATIONALITIES = [
  "Canada", "USA", "Sweden", "Finland", "Russia", "Czechia",
  "Slovakia", "Switzerland", "Germany", "Latvia", "Norway", "Denmark",
];

// Roughly mirrors a real draft class's position mix — more defensemen and
// centers get drafted than any single other position, goalies are the rarest.
const PROSPECT_POSITIONS = ["C", "C", "LW", "RW", "D", "D", "D", "G"];

function randomPosition() {
  return PROSPECT_POSITIONS[Math.floor(Math.random() * PROSPECT_POSITIONS.length)];
}

function randomNationality() {
  return PROSPECT_NATIONALITIES[Math.floor(Math.random() * PROSPECT_NATIONALITIES.length)];
}

function randomProspectName() {
  const first = firstNames[Math.floor(Math.random() * firstNames.length)];
  const last = lastNames[Math.floor(Math.random() * lastNames.length)];
  return `${first} ${last}`;
}

// Defensemen and goalies skew a couple inches/pounds bigger on average, same
// as real draft classes, but with enough spread that a small speedy D-man or
// a big lanky winger both still show up.
function randomHeightInches(position) {
  const base = position === "D" || position === "G" ? 73 : 71;
  return Math.round(clamp(base + (Math.random() * 10 - 5), 66, 79));
}

function randomWeightLbs(position) {
  const base = position === "D" || position === "G" ? 205 : 188;
  return Math.round(clamp(base + (Math.random() * 40 - 20), 160, 240));
}

// 18-year-old prospects are deliberately generated well below the 60-95
// range real NHL rosters use (see data.js's buildPlayers) — they're
// unproven, which is the whole reason potential/scouting exists. If
// targetOverall is given (import path), attributes are generated around
// that center instead of a random quality base, so an imported prospect's
// attributes stay internally consistent with the overall they implied.
function generateProspectAttributes(position, targetOverall) {
  const attrs = position === "G" ? GOALIE_ATTRS : SKATER_ATTRS;
  const spread = position === "G" ? 9 : 11;
  const qualityBase = targetOverall ?? (position === "G" ? 40 + Math.random() * 24 : 38 + Math.random() * 26);

  const attributes = {};
  attrs.forEach((attr) => {
    attributes[attr] = clamp(Math.round(qualityBase + (Math.random() * spread * 2 - spread)), 35, 90);
  });
  const overall = Math.round(mean(attrs.map((attr) => attributes[attr])));
  return { attributes, overall };
}

function normalizePosition(position) {
  const upper = (position || "").trim().toUpperCase();
  return ["C", "LW", "RW", "D", "G"].includes(upper) ? upper : null;
}

// Builds one full prospect (hidden attributes/potential included). Overrides
// come from a CSV import row — only the public fields (name, position,
// nationality, height, weight) can ever be overridden; hidden true quality
// is always freshly rolled by the game, generated or imported alike, which
// is what keeps the ranking's busts/gems meaningful either way.
function buildProspect(overrides = {}) {
  const position = normalizePosition(overrides.position) || randomPosition();
  const { attributes, overall } = generateProspectAttributes(position);
  const potential = generatePotential(18, overall);

  return {
    name: overrides.name || randomProspectName(),
    position,
    nationality: overrides.nationality || randomNationality(),
    heightInches: overrides.heightInches || randomHeightInches(position),
    weightLbs: overrides.weightLbs || randomWeightLbs(position),
    age: 18,
    overall,
    attributes,
    potential,
  };
}

function trueProspectScore(overall, potential) {
  return overall + potential.stars * 6;
}

// Box-Muller transform for approximately normal noise.
function gaussianNoise(stdDev) {
  const u1 = Math.max(Math.random(), 1e-9);
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return z * stdDev;
}

// The public rank is only "loosely based" on hidden true quality — scouting
// is imperfect. Each prospect's true overall+potential score gets a bounded
// random nudge before sorting, which produces real busts (a highly-ranked
// prospect whose hidden quality is actually middling) and gems (a
// lightly-regarded prospect who's secretly excellent), while a large enough
// true-quality gap still wins out most of the time — this is a nudge on
// each prospect's spot, not a full reshuffle to random order.
const PROSPECT_RANK_NOISE_STDEV = 9;

function assignProspectRanks(prospects) {
  const scored = prospects.map((p) => ({
    ...p,
    _score: trueProspectScore(p.overall, p.potential) + gaussianNoise(PROSPECT_RANK_NOISE_STDEV),
  }));
  scored.sort((a, b) => b._score - a._score);
  return scored.map((p, idx) => {
    const { _score, ...rest } = p;
    return { ...rest, prospectRank: idx + 1 };
  });
}

// Public-facing shape only — deliberately omits overall/potential/attributes.
function mapProspectRow(row) {
  return {
    id: row.id,
    seasonNumber: row.season_number,
    name: row.name,
    position: row.position,
    nationality: row.nationality,
    heightInches: row.height_inches,
    weightLbs: row.weight_lbs,
    prospectRank: row.prospect_rank,
    source: row.source,
  };
}

async function getDraftClass(seasonNumber) {
  const { rows } = await pool.query(
    "SELECT * FROM draft_prospects WHERE season_number = $1 ORDER BY prospect_rank",
    [seasonNumber]
  );
  return rows.map(mapProspectRow);
}

async function persistDraftClass(seasonNumber, prospects, source) {
  const ranked = assignProspectRanks(prospects);
  await withTransaction(async (client) => {
    await client.query("DELETE FROM draft_prospects WHERE season_number = $1", [seasonNumber]);
    for (const p of ranked) {
      await client.query(
        `INSERT INTO draft_prospects
           (season_number, name, position, nationality, height_inches, weight_lbs, age, overall, attributes, potential, prospect_rank, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          seasonNumber,
          p.name,
          p.position,
          p.nationality,
          p.heightInches,
          p.weightLbs,
          p.age,
          p.overall,
          JSON.stringify(p.attributes),
          JSON.stringify(p.potential),
          p.prospectRank,
          source,
        ]
      );
    }
  });
  return getDraftClass(seasonNumber);
}

// Default class size: one prospect per draft pick that season plus a handful
// of extras who go undrafted, same as a real draft class.
async function generateRandomDraftClass(seasonNumber, count) {
  const numTeams = (await getTeams()).length;
  const size = count || DRAFT_ROUNDS * numTeams + 8;
  const prospects = Array.from({ length: size }, () => buildProspect());
  return persistDraftClass(seasonNumber, prospects, "generated");
}

// rows: [{ name, position?, nationality?, heightInches?, weightLbs? }, ...]
// parsed from user-uploaded CSV. Hidden overall/potential/attributes are
// always freshly rolled here too — never taken from the import — so an
// imported class's ranking still has real busts and gems rather than just
// reflecting whatever order the user listed names in.
async function importDraftClass(seasonNumber, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw badRequest("Import must include at least one prospect");
  }
  const prospects = rows.map((row, idx) => {
    if (!row.name || !row.name.trim()) {
      throw badRequest(`Row ${idx + 1} is missing a name`);
    }
    return buildProspect(row);
  });
  return persistDraftClass(seasonNumber, prospects, "imported");
}

// --- Draft (pick mechanics) ---
//
// Picks proceed in a single flat order (overall pick number 1, 2, 3...)
// computed from the existing draft_picks/computeDraftOrder machinery — a
// pick's CURRENT owner (post any trades from earlier phases) is who's on
// the clock for it. CPU teams auto-pick immediately; a human team's pick
// pauses the loop for the frontend to prompt that GM.

async function getOrderedDraftPicks(seasonNumber) {
  const picks = await getDraftPicks({ seasonNumber });
  return [...picks].sort((a, b) => a.overallPickNumber - b.overallPickNumber);
}

// Real entry-level contracts are capped near the league floor regardless of
// how good the prospect is — the payoff for talent comes on the contract
// AFTER the ELC, not immediately — so this is deliberately flat rather than
// scaled by overall (unlike every other contract formula in this file).
function entryLevelContract() {
  return { years: 3, aavMillions: 0.925 };
}

function defaultStatsFor(position) {
  return position === "G"
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
}

// Converts a prospect into a real players row on the picking team, then
// removes it from the draft board. Hidden attributes/overall/potential
// carry over exactly as scouted — the whole point of storing a prospect's
// full profile up front (see the draft prospects section above) was so
// this conversion needs no new generation logic of its own.
async function executeDraftPick(teamId, prospectId) {
  await withTransaction(async (client) => {
    const { rows } = await client.query("SELECT * FROM draft_prospects WHERE id = $1", [prospectId]);
    if (rows.length === 0) throw notFound(`Prospect ${prospectId} not found`);
    const prospect = rows[0];
    const contract = entryLevelContract();
    const idRes = await client.query("SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM players");
    const nextId = idRes.rows[0].next_id;
    const jerseyNumber = Math.floor(Math.random() * 89) + 10;

    await client.query(
      `INSERT INTO players
         (id, team_id, name, position, jersey_number, age, overall, cap_hit, contract_years_left,
          in_game_status, roster_assignment, attributes, potential, stats)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'needs_update','MINORS',$10,$11,$12)`,
      [
        nextId,
        teamId,
        prospect.name,
        prospect.position,
        jerseyNumber,
        prospect.age,
        prospect.overall,
        contract.aavMillions,
        // +1 for the same reason a fresh resign offer gets it — see
        // resolveResigningRound. The draft happens after this season's
        // games are already done, so this rookie deal hasn't had any of
        // its seasons "used" yet; the universal end-of-cycle decrement in
        // advanceLeaguePhase's wraparound branch will bring it back down
        // to the real 3-year term at exactly the right point.
        contract.years + 1,
        JSON.stringify(prospect.attributes),
        JSON.stringify(prospect.potential),
        JSON.stringify(defaultStatsFor(prospect.position)),
      ]
    );
    await client.query("DELETE FROM draft_prospects WHERE id = $1", [prospectId]);
  });
}

async function getDraftStatus() {
  const leaguePhase = await getLeaguePhase();
  if (leaguePhase.phase !== "draft") {
    return { inDraftPhase: false };
  }
  const orderedPicks = await getOrderedDraftPicks(leaguePhase.seasonNumber);
  const { rows } = await pool.query("SELECT current_pick_index FROM league_state WHERE id = 1");
  const pickIndex = rows[0].current_pick_index;
  const complete = pickIndex >= orderedPicks.length;
  return {
    inDraftPhase: true,
    complete,
    currentPickIndex: pickIndex,
    totalPicks: orderedPicks.length,
    onTheClock: complete ? null : orderedPicks[pickIndex],
  };
}

// How many rank spots of "reach" a maximum-need team (need = 1.0) is
// willing to move a prospect up the board for, scaled continuously by need
// rather than a hard need/no-need cutoff — a team with a real hole doesn't
// suddenly ignore need entirely, and a team with zero need never reaches at
// all. A generated class runs ~64 deep (DRAFT_ROUNDS * numTeams + 8), so 10
// spots is a meaningful reach without letting pure need override a large
// true talent gap — "if the next goalie is ranked far away... they
// shouldn't take him. But if it's not far away, they should," per spec.
const DRAFT_NEED_REACH_MAX = 10;

// Still fundamentally best-player-available, but a team's need at a
// prospect's position effectively moves that prospect up the board by up
// to DRAFT_NEED_REACH_MAX spots — enough to win out over a marginally
// better-ranked prospect at a position the team doesn't need, but not
// enough to leapfrog a prospect who's dramatically better ranked. Lowest
// adjusted rank wins, same "smaller number is better" scale prospectRank
// already uses.
function pickBestProspectForTeam(board, teamNeeds) {
  let best = null;
  let bestAdjustedRank = Infinity;
  for (const prospect of board) {
    const need = teamNeeds[needGroupForPosition(prospect.position)];
    const adjustedRank = prospect.prospectRank - need * DRAFT_NEED_REACH_MAX;
    if (adjustedRank < bestAdjustedRank) {
      bestAdjustedRank = adjustedRank;
      best = prospect;
    }
  }
  return best;
}

// Auto-picks the smartest remaining prospect (see pickBestProspectForTeam)
// for every consecutive CPU-owned pick, stopping the instant a human-owned
// pick comes up (or the draft runs out of picks). Safe to call any time
// during the draft phase — a no-op if it's already a human's turn or the
// draft is complete — so the frontend can just call it on load to catch up
// any leading CPU picks. Needs are recomputed fresh before every single
// pick (not once up front) since a team drafting, say, a goalie in round 2
// genuinely lowers its own goalie need for its next pick in round 4 —
// executeDraftPick has already landed that player on the roster by the time
// the loop comes back around.
async function advanceDraft() {
  const leaguePhase = await getLeaguePhase();
  if (leaguePhase.phase !== "draft") {
    throw badRequest("Not currently in the draft phase");
  }

  const orderedPicks = await getOrderedDraftPicks(leaguePhase.seasonNumber);
  let { rows } = await pool.query("SELECT current_pick_index FROM league_state WHERE id = 1");
  let pickIndex = rows[0].current_pick_index;

  while (pickIndex < orderedPicks.length) {
    const pick = orderedPicks[pickIndex];
    if (pick.currentTeam.isHumanControlled) break;

    const board = await getDraftClass(leaguePhase.seasonNumber);
    if (board.length === 0) break; // shouldn't normally happen — more prospects than picks by design

    const needsByTeamId = await computeTeamNeeds();
    const chosen = pickBestProspectForTeam(board, needsByTeamId.get(pick.currentTeam.id));

    await executeDraftPick(pick.currentTeam.id, chosen.id);
    pickIndex++;
    await pool.query("UPDATE league_state SET current_pick_index = $1 WHERE id = 1", [pickIndex]);
  }

  return getDraftStatus();
}

// The human-GM equivalent of advanceDraft's CPU auto-pick — validates it's
// actually this team's turn, executes the pick, then resumes the auto-pick
// loop so any CPU picks immediately following also happen right away.
async function makeDraftPick({ teamId, prospectId }) {
  const leaguePhase = await getLeaguePhase();
  if (leaguePhase.phase !== "draft") {
    throw badRequest("Not currently in the draft phase");
  }

  const orderedPicks = await getOrderedDraftPicks(leaguePhase.seasonNumber);
  const { rows } = await pool.query("SELECT current_pick_index FROM league_state WHERE id = 1");
  const pickIndex = rows[0].current_pick_index;
  if (pickIndex >= orderedPicks.length) {
    throw badRequest("The draft is already complete");
  }

  const currentPick = orderedPicks[pickIndex];
  if (!currentPick.currentTeam.isHumanControlled) {
    throw badRequest("It's not currently a human GM's turn to pick");
  }
  if (currentPick.currentTeam.id !== teamId) {
    throw badRequest(`It's ${currentPick.currentTeam.city} ${currentPick.currentTeam.name}'s turn to pick, not yours`);
  }

  await executeDraftPick(teamId, prospectId);
  await pool.query("UPDATE league_state SET current_pick_index = current_pick_index + 1 WHERE id = 1");
  return advanceDraft();
}

// --- Trades ---
//
// Assets on both sides always add up to a single, comparable number: each
// player and each draft pick already carries a 1-20 tradeValue from the
// exact same scale (see computeTradeValue / draftPickTradeValue above), so a
// trade offer is just "sum of one side's values vs. the other's" — no
// separate valuation system needed.

const MAX_TRADE_ASSETS_PER_SIDE = 5;
const PACKAGE_DISCOUNT_PER_ASSET = 3;

// A package of several mediocre assets should NOT out-value one great asset
// with the same raw sum (1 player worth 20 vs. 2 players worth 10 each) —
// every asset in a trade total is discounted before summing, so quantity
// stops being a way to launder value. Floored at 1 so a throw-in never goes
// negative or cancels out anything.
function discountedAssetValue(rawValue) {
  return Math.max(1, rawValue - PACKAGE_DISCOUNT_PER_ASSET);
}

// How much a team likes what it's being offered: ratio of value it would
// RECEIVE to value it's giving up. >1 means they're winning the trade.
function tradeInterestLevel(ratio) {
  if (ratio < 0.6) return "Not interested";
  if (ratio < 0.85) return "Slightly interested";
  if (ratio < 1.15) return "Interested";
  if (ratio < 1.5) return "Very interested";
  return "Highly interested";
}

// Resolves a { playerIds, pickIds } offer into the real player/pick objects,
// checking each one actually belongs to the offering team right now — you
// can't trade what you don't have, including a pick someone already traded
// away earlier this session.
async function resolveTradeAssets(teamId, { playerIds = [], pickIds = [] }, allPlayers, allPicks) {
  const total = playerIds.length + pickIds.length;
  if (total === 0) {
    throw badRequest(`Team ${teamId} must offer at least one player or pick`);
  }
  if (total > MAX_TRADE_ASSETS_PER_SIDE) {
    throw badRequest(`A team can only send up to ${MAX_TRADE_ASSETS_PER_SIDE} players/picks in a trade`);
  }

  const players = playerIds.map((id) => {
    const player = allPlayers.find((p) => p.id === id);
    if (!player) throw notFound(`Player ${id} not found`);
    if (player.teamId !== teamId) throw badRequest(`${player.name} does not belong to team ${teamId}`);
    return player;
  });

  const picks = pickIds.map((id) => {
    const pick = allPicks.find((p) => p.id === id);
    if (!pick) throw notFound(`Draft pick ${id} not found`);
    if (pick.currentTeam.id !== teamId) throw badRequest(`Pick ${id} is not currently held by team ${teamId}`);
    return pick;
  });

  const totalValue =
    players.reduce((sum, p) => sum + discountedAssetValue(p.tradeValue), 0) +
    picks.reduce((sum, p) => sum + discountedAssetValue(p.tradeValue), 0);
  return { players, picks, totalValue };
}

async function evaluateTradeOffer({ teamAId, teamBId, teamAAssets, teamBAssets }) {
  if (teamAId === teamBId) {
    throw badRequest("Cannot trade with the same team");
  }

  const [teams, allPlayers, allPicks] = await Promise.all([getTeams(), getPlayers(), getDraftPicks()]);
  const teamsById = new Map(teams.map((t) => [t.id, t]));
  if (!teamsById.has(teamAId)) throw notFound(`Team ${teamAId} not found`);
  if (!teamsById.has(teamBId)) throw notFound(`Team ${teamBId} not found`);

  const [resolvedA, resolvedB, capA, capB, season] = await Promise.all([
    resolveTradeAssets(teamAId, teamAAssets, allPlayers, allPicks),
    resolveTradeAssets(teamBId, teamBAssets, allPlayers, allPicks),
    getTeamCapHit(teamAId),
    getTeamCapHit(teamBId),
    getSeasonInfo(),
  ]);

  const ratioForA = resolvedB.totalValue / Math.max(resolvedA.totalValue, 1);
  const ratioForB = resolvedA.totalValue / Math.max(resolvedB.totalValue, 1);

  const ceiling = getCapCeiling(season.seasonNumber);
  // Picks carry no cap hit — only the players changing hands move the
  // needle. Rounded the same way every other cap figure is.
  const projectedCapA = Math.round((capA - sumCapHit(resolvedA.players) + sumCapHit(resolvedB.players)) * 1000) / 1000;
  const projectedCapB = Math.round((capB - sumCapHit(resolvedB.players) + sumCapHit(resolvedA.players)) * 1000) / 1000;

  const summarize = (team, resolved, ratio, projectedCap) => ({
    team,
    players: resolved.players.map((p) => ({ id: p.id, name: p.name, position: p.position, tradeValue: p.tradeValue })),
    picks: resolved.picks.map((p) => ({ id: p.id, seasonNumber: p.seasonNumber, round: p.round, overallPickNumber: p.overallPickNumber, tradeValue: p.tradeValue })),
    totalValueGiven: resolved.totalValue,
    interest: { ratio: Math.round(ratio * 100) / 100, label: tradeInterestLevel(ratio) },
    capImpact: { projected: projectedCap, ceiling, overCap: projectedCap > ceiling },
  });

  return {
    teamA: summarize(teamsById.get(teamAId), resolvedA, ratioForA, projectedCapA),
    teamB: summarize(teamsById.get(teamBId), resolvedB, ratioForB, projectedCapB),
  };
}

// --- Human vs human trade offers ---
//
// A trade between two human-controlled teams used to execute the instant
// either side clicked the button — no say from the other GM at all. Now it
// works the same way a CPU's offer to a human already did: the proposing
// team's assets and ask go into a pending offer, and nothing actually moves
// until the target team's own GM explicitly accepts it (or it sits
// declined/withdrawn and never happens).

async function proposeTradeOffer({ teamAId, teamBId, teamAAssets, teamBAssets }) {
  // Re-resolves and re-validates against current ownership rather than
  // trusting a client-held evaluation — assets could have been traded away
  // by someone else in between evaluating and proposing.
  const evaluation = await evaluateTradeOffer({ teamAId, teamBId, teamAAssets, teamBAssets });

  const teamsById = await getTeamsById();
  if (!teamsById.get(teamBId).isHumanControlled) {
    throw badRequest("The other team isn't human-controlled — submit a trade proposal instead.");
  }
  if (evaluation.teamA.capImpact.overCap) {
    throw badRequest(`This trade would put ${evaluation.teamA.team.city} ${evaluation.teamA.team.name} over the salary cap.`);
  }
  if (evaluation.teamB.capImpact.overCap) {
    throw badRequest(`This trade would put ${evaluation.teamB.team.city} ${evaluation.teamB.team.name} over the salary cap.`);
  }

  const { rows } = await pool.query(
    `INSERT INTO human_trade_offers
       (proposing_team_id, target_team_id, offered_player_ids, offered_pick_ids, requested_player_ids, requested_pick_ids)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      teamAId,
      teamBId,
      evaluation.teamA.players.map((p) => p.id),
      evaluation.teamA.picks.map((p) => p.id),
      evaluation.teamB.players.map((p) => p.id),
      evaluation.teamB.picks.map((p) => p.id),
    ]
  );

  await createNotification(
    teamBId,
    `${evaluation.teamA.team.abbr} sent you a trade offer.`
  );

  return { offerId: rows[0].id, evaluation };
}

// Plain-English "Player A, Player B, R2 pick" summary of a set of assets —
// shared by every trade notification message so the league transactions
// feed always says who actually moved, not just that a trade happened.
function describeAssetNames(playerIds, pickIds, playersById, picksById) {
  const parts = [
    ...playerIds.map((id) => playersById.get(id)?.name).filter(Boolean),
    ...pickIds.map((id) => (picksById.get(id) ? `R${picksById.get(id).round} pick` : null)).filter(Boolean),
  ];
  return parts.length > 0 ? parts.join(", ") : "nothing";
}

function describeTradeOfferAssets(playerIds, pickIds, playersById, picksById) {
  return {
    players: playerIds
      .map((id) => playersById.get(id))
      .filter(Boolean)
      .map((p) => ({ id: p.id, name: p.name, position: p.position, tradeValue: p.tradeValue })),
    picks: pickIds
      .map((id) => picksById.get(id))
      .filter(Boolean)
      .map((p) => ({ id: p.id, seasonNumber: p.seasonNumber, round: p.round, overallPickNumber: p.overallPickNumber, tradeValue: p.tradeValue })),
  };
}

// This team's own trade offers in both directions — incoming ones it needs
// to respond to, and outgoing ones it's still waiting on someone else for.
async function getHumanTradeOffers(teamId) {
  const [teamsById, players, picks] = await Promise.all([getTeamsById(), getPlayers(), getDraftPicks()]);
  const playersById = new Map(players.map((p) => [p.id, p]));
  const picksById = new Map(picks.map((p) => [p.id, p]));

  const { rows } = await pool.query(
    "SELECT * FROM human_trade_offers WHERE proposing_team_id = $1 OR target_team_id = $1 ORDER BY id DESC",
    [teamId]
  );

  const mapped = rows.map((r) => ({
    id: r.id,
    proposingTeam: teamsById.get(r.proposing_team_id),
    targetTeam: teamsById.get(r.target_team_id),
    offered: describeTradeOfferAssets(r.offered_player_ids, r.offered_pick_ids, playersById, picksById),
    requested: describeTradeOfferAssets(r.requested_player_ids, r.requested_pick_ids, playersById, picksById),
    status: r.status,
  }));

  return {
    incoming: mapped.filter((o) => o.targetTeam.id === teamId),
    outgoing: mapped.filter((o) => o.proposingTeam.id === teamId),
  };
}

// The target team's explicit accept/decline — the only place a human trade
// offer's assets actually move. Re-validates ownership and cap room on BOTH
// sides at accept time, since either roster could have changed since the
// offer was made.
async function respondToHumanTradeOffer({ teamId, offerId, accept }) {
  const { rows } = await pool.query("SELECT * FROM human_trade_offers WHERE id = $1", [offerId]);
  if (rows.length === 0) throw notFound(`Offer ${offerId} not found`);
  const offer = rows[0];
  if (offer.target_team_id !== teamId) throw badRequest("This offer isn't addressed to your team");
  if (offer.status !== "pending") throw badRequest("This offer has already been resolved");

  const teamsById = await getTeamsById();
  const targetAbbr = teamsById.get(teamId)?.abbr ?? "The other team";

  if (!accept) {
    await pool.query("UPDATE human_trade_offers SET status = 'declined' WHERE id = $1", [offerId]);
    await createNotification(offer.proposing_team_id, `${targetAbbr} declined your trade offer.`);
    return { status: "declined" };
  }

  const [players, picks] = await Promise.all([getPlayers(), getDraftPicks()]);
  const playersById = new Map(players.map((p) => [p.id, p]));
  const picksById = new Map(picks.map((p) => [p.id, p]));

  const offeredPlayers = offer.offered_player_ids.map((id) => playersById.get(id));
  const requestedPlayers = offer.requested_player_ids.map((id) => playersById.get(id));
  const ownershipOk =
    offeredPlayers.every((p) => p && p.teamId === offer.proposing_team_id) &&
    requestedPlayers.every((p) => p && p.teamId === teamId) &&
    offer.offered_pick_ids.every((id) => picksById.get(id)?.currentTeam.id === offer.proposing_team_id) &&
    offer.requested_pick_ids.every((id) => picksById.get(id)?.currentTeam.id === teamId);

  if (!ownershipOk) {
    await pool.query("UPDATE human_trade_offers SET status = 'expired' WHERE id = $1", [offerId]);
    throw badRequest("This offer is no longer valid — one of those assets has already moved.");
  }

  const [proposerCap, targetCap, season] = await Promise.all([
    getTeamCapHit(offer.proposing_team_id),
    getTeamCapHit(teamId),
    getSeasonInfo(),
  ]);
  const ceiling = getCapCeiling(season.seasonNumber);
  const projectedProposerCap = proposerCap - sumCapHit(offeredPlayers) + sumCapHit(requestedPlayers);
  const projectedTargetCap = targetCap - sumCapHit(requestedPlayers) + sumCapHit(offeredPlayers);
  if (projectedProposerCap > ceiling) {
    await pool.query("UPDATE human_trade_offers SET status = 'expired' WHERE id = $1", [offerId]);
    throw badRequest("The proposing team is no longer under the salary cap for this trade — offer can no longer be accepted.");
  }
  if (projectedTargetCap > ceiling) {
    throw badRequest("Accepting this trade would put your team over the salary cap.");
  }

  await withTransaction(async (client) => {
    for (const p of offeredPlayers) {
      await client.query("UPDATE players SET team_id = $1, in_game_status = 'needs_update' WHERE id = $2", [
        teamId,
        p.id,
      ]);
    }
    for (const pickId of offer.offered_pick_ids) {
      await client.query("UPDATE draft_picks SET current_team_id = $1 WHERE id = $2", [teamId, pickId]);
    }
    for (const p of requestedPlayers) {
      await client.query("UPDATE players SET team_id = $1, in_game_status = 'needs_update' WHERE id = $2", [
        offer.proposing_team_id,
        p.id,
      ]);
    }
    for (const pickId of offer.requested_pick_ids) {
      await client.query("UPDATE draft_picks SET current_team_id = $1 WHERE id = $2", [offer.proposing_team_id, pickId]);
    }
    await client.query("UPDATE human_trade_offers SET status = 'accepted' WHERE id = $1", [offerId]);
  });

  await createNotification(
    offer.proposing_team_id,
    `${targetAbbr} accepted your trade offer: sent ${describeAssetNames(offer.offered_player_ids, offer.offered_pick_ids, playersById, picksById)}, received ${describeAssetNames(offer.requested_player_ids, offer.requested_pick_ids, playersById, picksById)}.`
  );
  return { status: "accepted" };
}

// Lets the proposing team pull back its own pending offer before the other
// GM responds — e.g. they changed their mind, or the ask is stale.
async function withdrawHumanTradeOffer({ teamId, offerId }) {
  const { rows } = await pool.query("SELECT * FROM human_trade_offers WHERE id = $1", [offerId]);
  if (rows.length === 0) throw notFound(`Offer ${offerId} not found`);
  const offer = rows[0];
  if (offer.proposing_team_id !== teamId) throw badRequest("This isn't your offer to withdraw");
  if (offer.status !== "pending") throw badRequest("This offer has already been resolved");
  await pool.query("UPDATE human_trade_offers SET status = 'withdrawn' WHERE id = $1", [offerId]);
  return { status: "withdrawn" };
}

// --- CPU-targeted trade proposals (trade_period / post_playoff_trade) ---
//
// Only for trades where the other side is a CPU-controlled team — the
// instant Trade Center execution stays as-is for human-vs-human trades,
// since only two parties are ever involved there and there's nothing to
// contest. Here, multiple human GMs can all want the same CPU assets in the
// same round, so two-sided offers (same shape as an instant trade: what the
// proposer sends, what they want back) are submitted, then resolved
// together when the phase advances instead of applying immediately.

async function submitTradeProposal({
  teamId,
  targetTeamId,
  offeredPlayerIds = [],
  offeredPickIds = [],
  requestedPlayerIds = [],
  requestedPickIds = [],
}) {
  const leaguePhase = await getLeaguePhase();
  if (!["trade_period", "post_playoff_trade"].includes(leaguePhase.phase)) {
    throw badRequest(`Trade proposals aren't open during the '${leaguePhase.phase}' phase`);
  }
  if (teamId === targetTeamId) throw badRequest("Cannot propose a trade with your own team");

  const [teams, allPlayers, allPicks] = await Promise.all([getTeams(), getPlayers(), getDraftPicks()]);
  const proposingTeam = teams.find((t) => t.id === teamId);
  if (!proposingTeam) throw notFound(`Team ${teamId} not found`);
  if (!proposingTeam.isHumanControlled) throw badRequest("Only human-controlled teams can submit trade proposals");

  const targetTeam = teams.find((t) => t.id === targetTeamId);
  if (!targetTeam) throw notFound(`Team ${targetTeamId} not found`);
  if (targetTeam.isHumanControlled) {
    throw badRequest("That team is human-controlled — human-vs-human trades execute instantly from the Trade Center");
  }

  // Reuses the exact same asset-resolution/discounted-value math the
  // instant Trade Center uses, so both systems agree on what each side of a
  // trade is actually worth, and validates ownership on both sides up front.
  const [offered, requested] = await Promise.all([
    resolveTradeAssets(teamId, { playerIds: offeredPlayerIds, pickIds: offeredPickIds }, allPlayers, allPicks),
    resolveTradeAssets(targetTeamId, { playerIds: requestedPlayerIds, pickIds: requestedPickIds }, allPlayers, allPicks),
  ]);

  // Checked at submission for immediate feedback — resolveTradeProposals
  // re-checks authoritatively at resolution time, since a team's actual
  // room by then may differ (other proposals/signings resolving first).
  const [capProposer, capTarget, season] = await Promise.all([
    getTeamCapHit(teamId),
    getTeamCapHit(targetTeamId),
    getSeasonInfo(),
  ]);
  const ceiling = getCapCeiling(season.seasonNumber);
  const projectedProposerCap = capProposer - sumCapHit(offered.players) + sumCapHit(requested.players);
  if (projectedProposerCap > ceiling) {
    throw badRequest(`This proposal would put ${proposingTeam.city} ${proposingTeam.name} over the salary cap.`);
  }
  const projectedTargetCap = capTarget - sumCapHit(requested.players) + sumCapHit(offered.players);
  if (projectedTargetCap > ceiling) {
    throw badRequest(`This proposal would put ${targetTeam.city} ${targetTeam.name} over the salary cap.`);
  }

  await pool.query(
    `INSERT INTO trade_proposals
       (season_number, round, phase, proposing_team_id, target_team_id,
        offered_player_ids, offered_pick_ids, requested_player_ids, requested_pick_ids, offered_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      leaguePhase.seasonNumber,
      leaguePhase.phaseRound,
      leaguePhase.phase,
      teamId,
      targetTeamId,
      offered.players.map((p) => p.id),
      offered.picks.map((p) => p.id),
      requested.players.map((p) => p.id),
      requested.picks.map((p) => p.id),
      offered.totalValue,
    ]
  );

  return getTradeProposals(teamId);
}

// Board scoped to one team's own proposals — a real GM only ever sees their
// own pending/resolved offers, never a competitor's (same privacy rule as
// getFreeAgencyBoard above). teamId is optional only for internal/back-
// compat callers; every real caller passes one.
async function getTradeProposals(teamId) {
  const leaguePhase = await getLeaguePhase();
  const [teamsById, players, picks] = await Promise.all([getTeamsById(), getPlayers(), getDraftPicks()]);
  const playersById = new Map(players.map((p) => [p.id, p]));
  const picksById = new Map(picks.map((p) => [p.id, p]));

  const { rows } = await pool.query(
    teamId != null
      ? "SELECT * FROM trade_proposals WHERE season_number = $1 AND round = $2 AND phase = $3 AND proposing_team_id = $4 ORDER BY id"
      : "SELECT * FROM trade_proposals WHERE season_number = $1 AND round = $2 AND phase = $3 ORDER BY id",
    teamId != null
      ? [leaguePhase.seasonNumber, leaguePhase.phaseRound, leaguePhase.phase, teamId]
      : [leaguePhase.seasonNumber, leaguePhase.phaseRound, leaguePhase.phase]
  );

  const describeAssets = (playerIds, pickIds) => ({
    players: playerIds
      .map((id) => playersById.get(id))
      .filter(Boolean)
      .map((p) => ({ id: p.id, name: p.name, position: p.position, tradeValue: p.tradeValue })),
    picks: pickIds
      .map((id) => picksById.get(id))
      .filter(Boolean)
      .map((p) => ({ id: p.id, seasonNumber: p.seasonNumber, round: p.round, overallPickNumber: p.overallPickNumber, tradeValue: p.tradeValue })),
  });

  return rows.map((r) => {
    const offered = describeAssets(r.offered_player_ids, r.offered_pick_ids);
    const requested = describeAssets(r.requested_player_ids, r.requested_pick_ids);
    return {
      id: r.id,
      proposingTeam: teamsById.get(r.proposing_team_id),
      targetTeam: teamsById.get(r.target_team_id),
      offeredPlayers: offered.players,
      offeredPicks: offered.picks,
      offeredValue: Number(r.offered_value),
      requestedPlayers: requested.players,
      requestedPicks: requested.picks,
      status: r.status,
    };
  });
}

// Confirms every asset on both sides of a pending proposal still belongs to
// who it's supposed to right now — an asset could have moved since the
// proposal was submitted, either via an earlier-resolved proposal this same
// pass or some other transaction in between.
async function proposalStillOwnsAssets(client, r) {
  const checks = [
    [r.offered_player_ids, "players", "team_id", r.proposing_team_id],
    [r.offered_pick_ids, "draft_picks", "current_team_id", r.proposing_team_id],
    [r.requested_player_ids, "players", "team_id", r.target_team_id],
    [r.requested_pick_ids, "draft_picks", "current_team_id", r.target_team_id],
  ];
  for (const [ids, table, column, ownerId] of checks) {
    if (ids.length === 0) continue;
    const { rows } = await client.query(`SELECT id FROM ${table} WHERE id = ANY($1) AND ${column} = $2`, [ids, ownerId]);
    if (rows.length !== ids.length) return false;
  }
  return true;
}

// Resolves one round: proposals are processed most-generous-offer-first: the
// first proposal to claim any given asset (on either side, for either team)
// wins it, and any later proposal touching an already-claimed asset is
// rejected. This is a direct generalization of the old single-target-player
// bidding rule (whoever offers the most for a contested CPU player wins) to
// the new two-sided, multi-asset offers the merged Trade Center produces.
// CPU teams are still fully passive (no counter-offers, no favorite-team
// bias) but they're not pushovers either: a proposal only executes if the
// CPU actually comes out ahead — offered_value (what the CPU receives) has
// to exceed the discounted value of what it's giving up. A lopsided offer
// just gets rejected, same as a conflicted/no-longer-owned one.
async function resolveTradeProposals(seasonNumber, round, phase) {
  const { rows } = await pool.query(
    "SELECT * FROM trade_proposals WHERE season_number = $1 AND round = $2 AND phase = $3 AND status = 'pending' ORDER BY offered_value DESC, id ASC",
    [seasonNumber, round, phase]
  );
  if (rows.length === 0) return { executed: [] };

  const [teamsById, players, picks, needsByTeamId] = await Promise.all([
    getTeamsById(),
    getPlayers(),
    getDraftPicks(),
    computeTeamNeeds(),
  ]);
  const playersById = new Map(players.map((p) => [p.id, p]));
  const picksById = new Map(picks.map((p) => [p.id, p]));
  const describeIds = (playerIds, pickIds) => describeAssetNames(playerIds, pickIds, playersById, picksById);

  const spentPlayerIds = new Set();
  const spentPickIds = new Set();
  const executed = [];
  const ceiling = getCapCeiling(seasonNumber);
  const runningCapByTeam = new Map();
  const getRunningCap = async (teamId) => {
    if (!runningCapByTeam.has(teamId)) runningCapByTeam.set(teamId, await getTeamCapHit(teamId));
    return runningCapByTeam.get(teamId);
  };

  await withTransaction(async (client) => {
    for (const r of rows) {
      const targetAbbr = teamsById.get(r.target_team_id)?.abbr ?? "the other team";
      const involvedPlayerIds = [...r.offered_player_ids, ...r.requested_player_ids];
      const involvedPickIds = [...r.offered_pick_ids, ...r.requested_pick_ids];
      const conflicts =
        involvedPlayerIds.some((id) => spentPlayerIds.has(id)) || involvedPickIds.some((id) => spentPickIds.has(id));

      const stillValid = !conflicts && (await proposalStillOwnsAssets(client, r));
      if (!stillValid) {
        await client.query("UPDATE trade_proposals SET status = 'rejected' WHERE id = $1", [r.id]);
        await createNotification(
          r.proposing_team_id,
          `Your trade proposal to ${targetAbbr} (offered ${describeIds(r.offered_player_ids, r.offered_pick_ids)} for ${describeIds(r.requested_player_ids, r.requested_pick_ids)}) fell through — one of those assets was already gone.`,
          "failure"
        );
        continue;
      }

      // Judged on needs-adjusted value, not raw trade value (which is only
      // what offered_value, stored at submission, reflects) — the CPU
      // values what it's RECEIVING more if it fills a real need, and treats
      // what it's GIVING UP as more costly if that's a category it needs
      // itself, same need-aware lens driving every other CPU acquisition
      // decision in this file. Recomputed fresh here (not read from
      // offered_value) since both sides need to go through the identical
      // needs-adjusted scale to be comparable at all.
      const cpuNeeds = needsByTeamId.get(r.target_team_id);
      const requestedValue = sumNeedsAdjustedValue(r.requested_player_ids, r.requested_pick_ids, playersById, picksById, cpuNeeds);
      const offeredValueForCpu = sumNeedsAdjustedValue(r.offered_player_ids, r.offered_pick_ids, playersById, picksById, cpuNeeds);
      if (offeredValueForCpu <= requestedValue) {
        await client.query("UPDATE trade_proposals SET status = 'rejected' WHERE id = $1", [r.id]);
        await createNotification(
          r.proposing_team_id,
          `${targetAbbr} rejected your trade proposal (offered ${describeIds(r.offered_player_ids, r.offered_pick_ids)} for ${describeIds(r.requested_player_ids, r.requested_pick_ids)}) — not enough value for them.`,
          "failure"
        );
        continue;
      }

      const offeredCapHit = sumCapHit(r.offered_player_ids.map((id) => playersById.get(id)).filter(Boolean));
      const requestedCapHit = sumCapHit(r.requested_player_ids.map((id) => playersById.get(id)).filter(Boolean));
      const proposerCap = await getRunningCap(r.proposing_team_id);
      const targetCap = await getRunningCap(r.target_team_id);
      const projectedProposerCap = proposerCap - offeredCapHit + requestedCapHit;
      const projectedTargetCap = targetCap - requestedCapHit + offeredCapHit;
      if (projectedProposerCap > ceiling || projectedTargetCap > ceiling) {
        await client.query("UPDATE trade_proposals SET status = 'rejected' WHERE id = $1", [r.id]);
        await createNotification(
          r.proposing_team_id,
          `Your trade proposal to ${targetAbbr} (offered ${describeIds(r.offered_player_ids, r.offered_pick_ids)} for ${describeIds(r.requested_player_ids, r.requested_pick_ids)}) fell through — it would have put a team over the salary cap.`,
          "failure"
        );
        continue;
      }
      runningCapByTeam.set(r.proposing_team_id, projectedProposerCap);
      runningCapByTeam.set(r.target_team_id, projectedTargetCap);

      for (const pid of r.offered_player_ids) {
        await client.query("UPDATE players SET team_id = $1, in_game_status = 'needs_update' WHERE id = $2", [
          r.target_team_id,
          pid,
        ]);
        spentPlayerIds.add(pid);
      }
      for (const pickId of r.offered_pick_ids) {
        await client.query("UPDATE draft_picks SET current_team_id = $1 WHERE id = $2", [r.target_team_id, pickId]);
        spentPickIds.add(pickId);
      }
      for (const pid of r.requested_player_ids) {
        await client.query("UPDATE players SET team_id = $1, in_game_status = 'needs_update' WHERE id = $2", [
          r.proposing_team_id,
          pid,
        ]);
        spentPlayerIds.add(pid);
      }
      for (const pickId of r.requested_pick_ids) {
        await client.query("UPDATE draft_picks SET current_team_id = $1 WHERE id = $2", [r.proposing_team_id, pickId]);
        spentPickIds.add(pickId);
      }

      await client.query("UPDATE trade_proposals SET status = 'executed' WHERE id = $1", [r.id]);
      executed.push({ proposalId: r.id, proposingTeamId: r.proposing_team_id, targetTeamId: r.target_team_id });
      await createNotification(
        r.proposing_team_id,
        `Trade completed with ${targetAbbr}: sent ${describeIds(r.offered_player_ids, r.offered_pick_ids)}, received ${describeIds(r.requested_player_ids, r.requested_pick_ids)}.`
      );
    }
  });

  return { executed };
}

// --- CPU-initiated trade offers (the reverse direction) ---
//
// trade_proposals above is humans proposing to CPUs, auto-resolved by
// value/cap at round end. This is CPUs proposing to humans — since a real
// GM should always get final say over their own roster, these never
// auto-execute; they sit pending until the human explicitly accepts or
// declines via respondToCpuTradeOffer. Generated lazily (once per round,
// tracked by cpu_trade_offer_batches) the first time a human checks their
// Trade Center that round, rather than needing a precise "entering a new
// round" hook the phase-advance machinery doesn't otherwise have.

const CPU_TRADE_OFFER_CHANCE = 0.35; // per CPU team, per human team, per round
// How the CPU's offered package compares to the target's value — a random
// spread so offers aren't uniformly lowball or uniformly generous.
const CPU_TRADE_VALUE_RATIO_RANGE = [0.75, 1.3];

async function generateCpuTradeOffers(seasonNumber, round, phase) {
  const [teams, allPlayers, allPicks] = await Promise.all([getTeams(), getPlayers(), getDraftPicks()]);
  const cpuTeams = teams.filter((t) => !t.isHumanControlled);
  const humanTeams = teams.filter((t) => t.isHumanControlled);
  if (cpuTeams.length === 0 || humanTeams.length === 0) return;

  const needsByTeamId = await computeTeamNeeds();
  const ceiling = getCapCeiling(seasonNumber);

  for (const cpu of cpuTeams) {
    const cpuNeeds = needsByTeamId.get(cpu.id);
    const cpuPlayers = allPlayers.filter((p) => p.teamId === cpu.id);
    const cpuPicks = allPicks.filter((pk) => pk.currentTeam.id === cpu.id);
    const cpuAssetPool = [
      ...cpuPlayers.map((p) => ({
        kind: "player",
        id: p.id,
        value: discountedAssetValue(p.tradeValue),
        needGroup: needGroupForPosition(p.position),
      })),
      ...cpuPicks.map((pk) => ({ kind: "pick", id: pk.id, value: discountedAssetValue(pk.tradeValue), needGroup: "picks" })),
    ];
    if (cpuAssetPool.length === 0) continue;
    const cpuCapNow = await getTeamCapHit(cpu.id);

    for (const human of humanTeams) {
      if (Math.random() > CPU_TRADE_OFFER_CHANCE) continue;

      const humanRoster = allPlayers.filter((p) => p.teamId === human.id);
      if (humanRoster.length === 0) continue;
      // Skews toward whichever position the CPU actually needs, same as FA
      // targeting — a team thin on defense goes shopping for a defenseman
      // even if a forward on the same roster carries a bigger raw value.
      const [target] = weightedSampleWithoutReplacement(
        humanRoster,
        1,
        (p) => Math.max(1, p.tradeValue) ** 2 * needValueMultiplier(cpuNeeds[needGroupForPosition(p.position)])
      );
      if (!target) continue;

      const targetValue = discountedAssetValue(target.tradeValue);
      const budget = targetValue * randomInRange(CPU_TRADE_VALUE_RATIO_RANGE);

      // Assemble 1-MAX_TRADE_ASSETS_PER_SIDE assets cheapest-first (shuffled
      // for tie variety, then stable-sorted ascending by an EFFECTIVE value
      // that inflates whatever the CPU itself needs — a team desperate for
      // goalies won't ship out its own good goalie as budget filler just
      // because its raw value happens to be low; a need-inflated asset
      // reads as "expensive" and gets picked last, same as a real GM
      // protecting the pieces it can't afford to lose). A real team also
      // doesn't shop its franchise cornerstone as filler just because the
      // raw numbers balance; reaching for a genuinely valuable piece only
      // happens when the CPU's (need-aware) depth alone can't cover the cost.
      const ordered = [...cpuAssetPool]
        .sort(() => Math.random() - 0.5)
        .sort(
          (a, b) =>
            a.value * needValueMultiplier(cpuNeeds[a.needGroup]) - b.value * needValueMultiplier(cpuNeeds[b.needGroup])
        );
      const chosen = [];
      let runningValue = 0;
      for (const asset of ordered) {
        if (chosen.length >= MAX_TRADE_ASSETS_PER_SIDE) break;
        chosen.push(asset);
        runningValue += asset.value;
        if (runningValue >= budget) break;
      }
      if (chosen.length === 0) continue;

      const offeredPlayerIds = chosen.filter((a) => a.kind === "player").map((a) => a.id);
      const offeredPickIds = chosen.filter((a) => a.kind === "pick").map((a) => a.id);

      // The CPU gives up offeredPlayerIds' cap and takes on the target's —
      // skip if that would put the CPU itself over the cap.
      const givingUpCap = sumCapHit(offeredPlayerIds.map((id) => cpuPlayers.find((p) => p.id === id)).filter(Boolean));
      const projectedCpuCap = cpuCapNow - givingUpCap + capContribution(target);
      if (projectedCpuCap > ceiling) continue;

      await pool.query(
        `INSERT INTO cpu_trade_offers
           (season_number, round, phase, cpu_team_id, target_team_id,
            offered_player_ids, offered_pick_ids, requested_player_ids, requested_pick_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [seasonNumber, round, phase, cpu.id, human.id, offeredPlayerIds, offeredPickIds, [target.id], []]
      );
    }
  }
}

// Generates this round's CPU offers exactly once — "no rows yet" alone
// can't distinguish "not generated" from "generated, nobody offered", so
// cpu_trade_offer_batches is the actual generated-or-not marker.
async function ensureCpuTradeOffers(seasonNumber, round, phase) {
  const { rows } = await pool.query(
    "SELECT 1 FROM cpu_trade_offer_batches WHERE season_number = $1 AND round = $2 AND phase = $3",
    [seasonNumber, round, phase]
  );
  if (rows.length > 0) return;
  await generateCpuTradeOffers(seasonNumber, round, phase);
  await pool.query(
    "INSERT INTO cpu_trade_offer_batches (season_number, round, phase) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    [seasonNumber, round, phase]
  );
}

// Board of CPU-initiated offers currently addressed to this human team —
// generates the round's batch on first read (see ensureCpuTradeOffers)
// rather than needing a dedicated "entering a round" hook.
async function getCpuTradeOffers(teamId) {
  const leaguePhase = await getLeaguePhase();
  if (!["trade_period", "post_playoff_trade"].includes(leaguePhase.phase)) {
    return [];
  }
  await ensureCpuTradeOffers(leaguePhase.seasonNumber, leaguePhase.phaseRound, leaguePhase.phase);

  const [teamsById, players, picks] = await Promise.all([getTeamsById(), getPlayers(), getDraftPicks()]);
  const playersById = new Map(players.map((p) => [p.id, p]));
  const picksById = new Map(picks.map((p) => [p.id, p]));

  const describeAssets = (playerIds, pickIds) => ({
    players: playerIds
      .map((id) => playersById.get(id))
      .filter(Boolean)
      .map((p) => ({ id: p.id, name: p.name, position: p.position, tradeValue: p.tradeValue })),
    picks: pickIds
      .map((id) => picksById.get(id))
      .filter(Boolean)
      .map((p) => ({ id: p.id, seasonNumber: p.seasonNumber, round: p.round, overallPickNumber: p.overallPickNumber, tradeValue: p.tradeValue })),
  });

  const { rows } = await pool.query(
    "SELECT * FROM cpu_trade_offers WHERE season_number = $1 AND round = $2 AND phase = $3 AND target_team_id = $4 ORDER BY id",
    [leaguePhase.seasonNumber, leaguePhase.phaseRound, leaguePhase.phase, teamId]
  );

  return rows.map((r) => ({
    id: r.id,
    cpuTeam: teamsById.get(r.cpu_team_id),
    cpuSends: describeAssets(r.offered_player_ids, r.offered_pick_ids),
    cpuWants: describeAssets(r.requested_player_ids, r.requested_pick_ids),
    status: r.status,
  }));
}

// A human's explicit accept/decline of one CPU-initiated offer. Never
// auto-resolved — see the section comment above.
async function respondToCpuTradeOffer({ teamId, offerId, accept }) {
  const { rows } = await pool.query("SELECT * FROM cpu_trade_offers WHERE id = $1", [offerId]);
  if (rows.length === 0) throw notFound(`Offer ${offerId} not found`);
  const offer = rows[0];
  if (offer.target_team_id !== teamId) throw badRequest("This offer isn't addressed to your team");
  if (offer.status !== "pending") throw badRequest("This offer has already been resolved");

  // The round/phase could have moved on since this offer was generated
  // (the human sat on it, or is replaying a stale request) — an offer only
  // stays live for the round it was made in, same as everything else in
  // the trade/free-agency system.
  const leaguePhase = await getLeaguePhase();
  if (
    offer.season_number !== leaguePhase.seasonNumber ||
    offer.round !== leaguePhase.phaseRound ||
    offer.phase !== leaguePhase.phase
  ) {
    await pool.query("UPDATE cpu_trade_offers SET status = 'expired' WHERE id = $1", [offerId]);
    throw badRequest("This offer is from a previous round and is no longer available.");
  }

  const teamsById = await getTeamsById();
  const cpuAbbr = teamsById.get(offer.cpu_team_id)?.abbr ?? "the other team";

  if (!accept) {
    await pool.query("UPDATE cpu_trade_offers SET status = 'declined' WHERE id = $1", [offerId]);
    return { status: "declined" };
  }

  // Re-validate ownership — assets could have moved (another trade, the
  // draft, free agency) since this offer was generated.
  const [players, picks] = await Promise.all([getPlayers(), getDraftPicks()]);
  const playersById = new Map(players.map((p) => [p.id, p]));
  const picksById = new Map(picks.map((p) => [p.id, p]));

  const offeredPlayers = offer.offered_player_ids.map((id) => playersById.get(id));
  const requestedPlayers = offer.requested_player_ids.map((id) => playersById.get(id));
  const ownershipOk =
    offeredPlayers.every((p) => p && p.teamId === offer.cpu_team_id) &&
    requestedPlayers.every((p) => p && p.teamId === teamId) &&
    offer.offered_pick_ids.every((id) => picksById.get(id)?.currentTeam.id === offer.cpu_team_id);

  if (!ownershipOk) {
    await pool.query("UPDATE cpu_trade_offers SET status = 'expired' WHERE id = $1", [offerId]);
    throw badRequest("This offer is no longer valid — one of those assets has already moved.");
  }

  const [humanCap, season] = await Promise.all([getTeamCapHit(teamId), getSeasonInfo()]);
  const projectedHumanCap = humanCap - sumCapHit(requestedPlayers) + sumCapHit(offeredPlayers);
  if (projectedHumanCap > getCapCeiling(season.seasonNumber)) {
    throw badRequest("Accepting this trade would put your team over the salary cap.");
  }

  await withTransaction(async (client) => {
    for (const p of offeredPlayers) {
      await client.query("UPDATE players SET team_id = $1, in_game_status = 'needs_update' WHERE id = $2", [
        teamId,
        p.id,
      ]);
    }
    for (const pickId of offer.offered_pick_ids) {
      await client.query("UPDATE draft_picks SET current_team_id = $1 WHERE id = $2", [teamId, pickId]);
    }
    for (const p of requestedPlayers) {
      await client.query("UPDATE players SET team_id = $1 WHERE id = $2", [offer.cpu_team_id, p.id]);
    }
    for (const pickId of offer.requested_pick_ids) {
      await client.query("UPDATE draft_picks SET current_team_id = $1 WHERE id = $2", [offer.cpu_team_id, pickId]);
    }
    await client.query("UPDATE cpu_trade_offers SET status = 'accepted' WHERE id = $1", [offerId]);
  });

  await createNotification(
    teamId,
    `Accepted ${cpuAbbr}'s trade offer: sent ${describeAssetNames(offer.requested_player_ids, offer.requested_pick_ids, playersById, picksById)}, received ${describeAssetNames(offer.offered_player_ids, offer.offered_pick_ids, playersById, picksById)}.`
  );
  return { status: "accepted" };
}

// --- CPU vs CPU trades (no humans involved) ---
//
// Each call picks one random CPU team to shop a trade to one other random
// CPU team, built around the proposer's own needs — the same need-aware
// target/asset-selection logic generateCpuTradeOffers already uses for
// CPU-to-human offers. Unlike a CPU-to-human offer, there's no real person
// on the other end to wait on, so this evaluates and resolves in one pass
// using the same needs-adjusted accept/reject gate resolveTradeProposals
// uses for human-to-CPU proposals — the "receiving" side judges the offer
// by its own needs, same as every other CPU acquisition decision in this
// file. No pending state, no table of its own — it either happens right
// here or it doesn't. Called CPU_VS_CPU_OFFERS_PER_ROUND times per round
// (see PHASE_RESOLVERS) — most individual attempts don't clear the
// target's needs-adjusted bar (real trades between two self-interested
// GMs are the exception, not the rule), so several independent attempts
// per round is what actually produces a believable trickle of completed
// trades rather than a strict "exactly one offer" cap.
const CPU_VS_CPU_OFFERS_PER_ROUND = 5;

async function generateCpuVsCpuTrade(seasonNumber) {
  const [teams, allPlayers, allPicks] = await Promise.all([getTeams(), getPlayers(), getDraftPicks()]);
  const cpuTeams = teams.filter((t) => !t.isHumanControlled);
  if (cpuTeams.length < 2) return { executed: false };

  const proposer = cpuTeams[Math.floor(Math.random() * cpuTeams.length)];
  const otherCpus = cpuTeams.filter((t) => t.id !== proposer.id);
  const target = otherCpus[Math.floor(Math.random() * otherCpus.length)];

  const targetRoster = allPlayers.filter((p) => p.teamId === target.id);
  if (targetRoster.length === 0) return { executed: false };

  const needsByTeamId = await computeTeamNeeds();
  const proposerNeeds = needsByTeamId.get(proposer.id);
  const targetNeeds = needsByTeamId.get(target.id);
  const ceiling = getCapCeiling(seasonNumber);

  // Which of the target's players the proposer wants — skews toward the
  // proposer's own needs, same formula as every other CPU target-selection
  // decision in this file.
  const [wanted] = weightedSampleWithoutReplacement(
    targetRoster,
    1,
    (p) => Math.max(1, p.tradeValue) ** 2 * needValueMultiplier(proposerNeeds[needGroupForPosition(p.position)])
  );
  if (!wanted) return { executed: false };

  const proposerPlayers = allPlayers.filter((p) => p.teamId === proposer.id);
  const proposerPicks = allPicks.filter((pk) => pk.currentTeam.id === proposer.id);
  const proposerAssetPool = [
    ...proposerPlayers.map((p) => ({
      kind: "player",
      id: p.id,
      value: discountedAssetValue(p.tradeValue),
      needGroup: needGroupForPosition(p.position),
    })),
    ...proposerPicks.map((pk) => ({ kind: "pick", id: pk.id, value: discountedAssetValue(pk.tradeValue), needGroup: "picks" })),
  ];
  if (proposerAssetPool.length === 0) return { executed: false };

  const wantedValue = discountedAssetValue(wanted.tradeValue);
  const budget = wantedValue * randomInRange(CPU_TRADE_VALUE_RATIO_RANGE);

  // Cheapest-first, need-reluctance-weighted package assembly — identical
  // logic to generateCpuTradeOffers's own asset selection.
  const ordered = [...proposerAssetPool]
    .sort(() => Math.random() - 0.5)
    .sort(
      (a, b) =>
        a.value * needValueMultiplier(proposerNeeds[a.needGroup]) - b.value * needValueMultiplier(proposerNeeds[b.needGroup])
    );
  const chosen = [];
  let runningValue = 0;
  for (const asset of ordered) {
    if (chosen.length >= MAX_TRADE_ASSETS_PER_SIDE) break;
    chosen.push(asset);
    runningValue += asset.value;
    if (runningValue >= budget) break;
  }
  if (chosen.length === 0) return { executed: false };

  const offeredPlayerIds = chosen.filter((a) => a.kind === "player").map((a) => a.id);
  const offeredPickIds = chosen.filter((a) => a.kind === "pick").map((a) => a.id);

  const proposerCapNow = await getTeamCapHit(proposer.id);
  const proposerGivingUpCap = sumCapHit(offeredPlayerIds.map((id) => proposerPlayers.find((p) => p.id === id)).filter(Boolean));
  const projectedProposerCap = proposerCapNow - proposerGivingUpCap + capContribution(wanted);
  if (projectedProposerCap > ceiling) return { executed: false };

  // The target evaluates the offer against its OWN needs — the same
  // needs-adjusted gate a human-to-CPU proposal has to clear.
  const playersById = new Map(allPlayers.map((p) => [p.id, p]));
  const picksById = new Map(allPicks.map((pk) => [pk.id, pk]));
  const offeredValueForTarget = sumNeedsAdjustedValue(offeredPlayerIds, offeredPickIds, playersById, picksById, targetNeeds);
  const requestedValueForTarget = sumNeedsAdjustedValue([wanted.id], [], playersById, picksById, targetNeeds);
  if (offeredValueForTarget <= requestedValueForTarget) {
    return { executed: false, proposer, target };
  }

  const targetCapNow = await getTeamCapHit(target.id);
  const offeredCapHit = sumCapHit(offeredPlayerIds.map((id) => playersById.get(id)).filter(Boolean));
  const projectedTargetCap = targetCapNow - capContribution(wanted) + offeredCapHit;
  if (projectedTargetCap > ceiling) {
    return { executed: false, proposer, target };
  }

  await withTransaction(async (client) => {
    for (const pid of offeredPlayerIds) {
      await client.query("UPDATE players SET team_id = $1, in_game_status = 'needs_update' WHERE id = $2", [
        target.id,
        pid,
      ]);
    }
    for (const pickId of offeredPickIds) {
      await client.query("UPDATE draft_picks SET current_team_id = $1 WHERE id = $2", [target.id, pickId]);
    }
    await client.query("UPDATE players SET team_id = $1, in_game_status = 'needs_update' WHERE id = $2", [
      proposer.id,
      wanted.id,
    ]);
  });

  const describe = (playerIds, pickIds) => describeAssetNames(playerIds, pickIds, playersById, picksById);

  await createNotification(
    proposer.id,
    `Traded with ${target.abbr}: sent ${describe(offeredPlayerIds, offeredPickIds)}, received ${wanted.name}.`
  );
  await createNotification(
    target.id,
    `Traded with ${proposer.abbr}: sent ${wanted.name}, received ${describe(offeredPlayerIds, offeredPickIds)}.`
  );

  return { executed: true, proposer, target, offeredPlayerIds, offeredPickIds, wantedPlayerId: wanted.id };
}

// Aggregates a team's own not-yet-resolved actions across every mechanism
// that works this way (free agency bids, resign offers, trade proposals) —
// backs MyGM's "Pending Moves" tab. Each sub-board already enforces its own
// privacy scoping (getFreeAgencyBoard/getTradeProposals take teamId; resign
// offers are exclusive-incumbent by nature, filtered here to this team).
async function getPendingMoves(teamId) {
  const [faBoard, resignBoard, tradeProposals] = await Promise.all([
    getFreeAgencyBoard(teamId),
    getResigningBoard(),
    getTradeProposals(teamId),
  ]);

  const freeAgentOffers = faBoard.freeAgents
    .filter((p) => p.yourBid)
    .map((p) => ({
      player: { id: p.id, name: p.name, position: p.position, overall: p.overall },
      offer: p.yourBid,
    }));

  const resignOffers = resignBoard.players
    .filter((p) => p.team.id === teamId && p.currentOffer)
    .map((p) => ({
      player: { id: p.id, name: p.name, position: p.position, overall: p.overall },
      offer: p.currentOffer,
    }));

  const tradeOffers = tradeProposals.filter((p) => p.status === "pending");

  return { freeAgentOffers, resignOffers, tradeOffers };
}

// The commissioner's league-wide view of everything currently in motion —
// every human team's free agent bids and re-sign offers for the live round,
// plus every pending trade a human has put on the table (both to another
// human and to a CPU team). Unlike getPendingMoves above, this has no
// privacy scoping at all by design — the commissioner needs to see
// everyone's moves, not just their own.
async function getLeagueWidePendingMoves() {
  const leaguePhase = await getLeaguePhase();
  const [teamsById, players, picks] = await Promise.all([getTeamsById(), getPlayers(), getDraftPicks()]);
  const playersById = new Map(players.map((p) => [p.id, p]));
  const picksById = new Map(picks.map((p) => [p.id, p]));
  const describePlayer = (id) => {
    const p = playersById.get(id);
    return p ? { id: p.id, name: p.name, position: p.position, overall: p.overall } : { id };
  };

  const biddingOpen = ["free_agency", "trade_period"].includes(leaguePhase.phase);
  let freeAgentBids = [];
  if (biddingOpen) {
    const { rows } = await pool.query("SELECT * FROM free_agent_bids WHERE season_number = $1 AND round = $2", [
      leaguePhase.seasonNumber,
      leaguePhase.phaseRound,
    ]);
    freeAgentBids = rows.map((b) => ({
      team: teamsById.get(b.team_id),
      player: describePlayer(b.player_id),
      offer: { aavMillions: Number(b.aav_millions), years: b.years },
    }));
  }

  const resignBoard = await getResigningBoard();
  const resignOffers = resignBoard.players
    .filter((p) => p.currentOffer)
    .map((p) => ({
      team: p.team,
      player: { id: p.id, name: p.name, position: p.position, overall: p.overall },
      offer: p.currentOffer,
    }));

  const cpuTargetTrades = (await getTradeProposals(null))
    .filter((p) => p.status === "pending")
    .map((p) => ({
      proposingTeam: p.proposingTeam,
      targetTeam: p.targetTeam,
      offered: { players: p.offeredPlayers, picks: p.offeredPicks },
      requestedValue: p.offeredValue,
    }));

  const { rows: humanOfferRows } = await pool.query(
    "SELECT * FROM human_trade_offers WHERE status = 'pending' ORDER BY id"
  );
  const humanTrades = humanOfferRows.map((r) => ({
    proposingTeam: teamsById.get(r.proposing_team_id),
    targetTeam: teamsById.get(r.target_team_id),
    offered: describeTradeOfferAssets(r.offered_player_ids, r.offered_pick_ids, playersById, picksById),
    requested: describeTradeOfferAssets(r.requested_player_ids, r.requested_pick_ids, playersById, picksById),
  }));

  return {
    seasonNumber: leaguePhase.seasonNumber,
    phase: leaguePhase.phase,
    phaseRound: leaguePhase.phaseRound,
    freeAgentBids,
    resignOffers,
    humanTrades,
    cpuTargetTrades,
  };
}

module.exports = {
  getTeams,
  getPlayers,
  getPlayersByTeam,
  getGames,
  getStandings,
  getPendingHumanGames,
  submitScore,
  simulateGame,
  advanceSimulation,
  simulateAllRemainingGames,
  advanceLeagueDate,
  getSeasonInfo,
  setPlayoffChampion,
  getSeasonResults,
  getLeaguePhase,
  advanceLeaguePhase,
  getReadyStatus,
  setTeamReady,
  getFreeAgents,
  getFreeAgencyBoard,
  submitFreeAgentBid,
  getResigningBoard,
  submitResignOffer,
  getLineupSlots,
  assignLineupSlot,
  autoSetLineup,
  getRosterChanges,
  runProgression,
  getLatestProgression,
  progressPlayer, // exported for standalone analysis scripts (see server/scripts/) — pure, no DB calls
  getDraftPicks,
  getDraftOrder,
  setDraftOrder,
  generateDraftPicksForSeason,
  ensureDraftPicksThroughWindow,
  getDraftClass,
  generateRandomDraftClass,
  importDraftClass,
  getDraftStatus,
  advanceDraft,
  pickBestProspectForTeam, // exported for standalone analysis/verification scripts (see server/scripts/) — pure, no DB calls
  makeDraftPick,
  evaluateTradeOffer,
  proposeTradeOffer,
  getHumanTradeOffers,
  respondToHumanTradeOffer,
  withdrawHumanTradeOffer,
  submitTradeProposal,
  getTradeProposals,
  getPendingMoves,
  getLeagueWidePendingMoves,
  getNotifications,
  getUnreadNotificationCount,
  markNotificationsRead,
  getLeagueTransactions,
  createUser,
  getUsers,
  getUserById,
  deleteUser,
  verifyLogin,
  getGoalieLeaders,
  getScorers,
  generateCpuFreeAgentBids, // exported for standalone analysis/verification scripts (see server/scripts/) — no DB side effects beyond inserting bid rows
  generateCpuResignOffers,
  resolveFreeAgencyRound,
  resolveResigningRound,
  resolveTradeProposals, // exported for standalone analysis/verification scripts (see server/scripts/) — same pattern as the other round resolvers above
  computeContractDemand, // exported for standalone import/analysis scripts (see server/scripts/) — pure, no DB calls
  getCapCeiling,
  getTeamCapHit,
  getTeamCapSummary,
  generateCpuTradeOffers, // exported for standalone analysis/verification scripts (see server/scripts/) — same pattern as the other CPU generators above
  getCpuTradeOffers,
  respondToCpuTradeOffer,
  generateCpuVsCpuTrade, // exported for standalone analysis/verification scripts (see server/scripts/) — same pattern as the other CPU generators above
  computeTeamNeeds, // exported for standalone analysis/verification scripts (see server/scripts/) — same pattern as the other CPU generators above
  getTeamNeeds,
};

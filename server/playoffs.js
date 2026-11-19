// Playoff bracket, playoff games and playoff stats.
//
// The commissioner picks and seeds the playoff field (8 teams for OG HFL, the
// largest power of two up to 16 elsewhere). Every series is first-to-4. Round
// 1 pairs seeds 1v8, 4v5, 2v7, 3v6 (generally: best vs worst, laid out in
// standard bracket order); every later round is re-seeded — the best
// remaining seed plays the worst remaining seed — once the round before it is
// completely decided.
//
// Games: a series only ever holds the games already played plus the next one
// of an undecided series. A game between two human-controlled teams is a
// console game, scored by the commissioner (final score only, like the
// regular season); any game involving a CPU team is simulated with the same
// engine as the regular season. Player stats go to players.playoff_stats —
// separate from regular-season stats — and for console games they're entered
// as running totals (players.playoff_console_stats), mirroring the User Game
// Stats flow in store.js.
const { pool, withTransaction, getActiveLeagueSlug } = require("./db");
const store = require("./store");

const {
  teamStrength,
  distributeGoals,
  rollGameResult,
  zeroConsoleStats,
  applyConsoleStatsDelta,
  normalizeConsoleEntry,
  getTeamsById,
  badRequest,
  notFound,
} = store._internals;

const WINS_NEEDED = 4; // best-of-7
const MAX_GAMES = WINS_NEEDED * 2 - 1;
// 2-2-1-1-1: the higher seed hosts games 1, 2, 5 and 7.
const HIGH_SEED_HOME_GAMES = [1, 2, 5, 7];

// Explicit field size per league; anywhere else uses the largest power of two
// up to 16 that the league's team count allows.
const PLAYOFF_FIELD_SIZE = { og_hfl: 8 };
const MAX_DEFAULT_FIELD_SIZE = 16;

async function getFieldSize() {
  const slug = getActiveLeagueSlug() || process.env.LEAGUE;
  if (PLAYOFF_FIELD_SIZE[slug]) return PLAYOFF_FIELD_SIZE[slug];
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM teams");
  let size = 2;
  while (size * 2 <= Math.min(MAX_DEFAULT_FIELD_SIZE, rows[0].n)) size *= 2;
  return size;
}

function emptySeasonStats(position) {
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

// Standard bracket order for N seeds, e.g. N=8 -> 1,8,4,5,2,7,3,6 — read in
// consecutive pairs it gives the round-1 matchups with the top seeds kept
// apart as long as possible.
function bracketSeedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const next = order.length * 2;
    order = order.flatMap((s) => [s, next + 1 - s]);
  }
  return order;
}

function roundName(round, totalRounds) {
  const fromEnd = totalRounds - round;
  if (fromEnd === 0) return "Final";
  if (fromEnd === 1) return "Semifinals";
  if (fromEnd === 2) return "Quarterfinals";
  return `Round ${round}`;
}

async function getSeasonNumber() {
  return (await store.getLeaguePhase()).seasonNumber;
}

async function requirePlayoffsPhase() {
  const leaguePhase = await store.getLeaguePhase();
  if (leaguePhase.phase !== "playoffs") {
    throw badRequest("Playoff actions are only available during the 'playoffs' phase");
  }
  return leaguePhase;
}

// --- Bracket construction ---

async function createGame(client, series, gameNumber) {
  const highHome = HIGH_SEED_HOME_GAMES.includes(gameNumber);
  await client.query(
    `INSERT INTO playoff_games (series_id, game_number, home_team_id, away_team_id)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [
      series.id,
      gameNumber,
      highHome ? series.high_seed_team_id : series.low_seed_team_id,
      highHome ? series.low_seed_team_id : series.high_seed_team_id,
    ]
  );
}

async function createSeries(client, seasonNumber, round, slot, high, low) {
  const { rows } = await client.query(
    `INSERT INTO playoff_series
       (season_number, round, slot, high_seed_team_id, low_seed_team_id, high_seed, low_seed)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [seasonNumber, round, slot, high.teamId, low.teamId, high.seed, low.seed]
  );
  await createGame(client, rows[0], 1);
  return rows[0];
}

// Once every series in the latest round has a winner, builds the next round
// from the winners (re-seeded: best remaining vs worst remaining).
async function advanceBracket(client, seasonNumber) {
  const { rows: all } = await client.query(
    "SELECT * FROM playoff_series WHERE season_number = $1 ORDER BY round, slot",
    [seasonNumber]
  );
  if (all.length === 0) return;
  const round1Count = all.filter((s) => s.round === 1).length;
  const totalRounds = Math.log2(round1Count * 2);
  const latest = Math.max(...all.map((s) => s.round));
  if (latest >= totalRounds) return;

  const latestSeries = all.filter((s) => s.round === latest);
  if (!latestSeries.every((s) => s.winner_team_id != null)) return;

  const advancing = latestSeries
    .map((s) =>
      s.winner_team_id === s.high_seed_team_id
        ? { teamId: s.high_seed_team_id, seed: s.high_seed }
        : { teamId: s.low_seed_team_id, seed: s.low_seed }
    )
    .sort((a, b) => a.seed - b.seed);
  for (let i = 0; i < advancing.length / 2; i++) {
    await createSeries(client, seasonNumber, latest + 1, i, advancing[i], advancing[advancing.length - 1 - i]);
  }
}

// Re-tallies a series from its played games, keeps exactly one upcoming game
// while it's undecided, and moves the bracket on when it's decided. Throws if
// a correction would change a series' winner after the next round has already
// been built from it.
async function recomputeSeries(client, seriesId) {
  const { rows: seriesRows } = await client.query("SELECT * FROM playoff_series WHERE id = $1 FOR UPDATE", [seriesId]);
  const series = seriesRows[0];
  const { rows: games } = await client.query(
    "SELECT * FROM playoff_games WHERE series_id = $1 ORDER BY game_number",
    [seriesId]
  );

  let highWins = 0;
  let lowWins = 0;
  for (const g of games.filter((x) => x.status === "final")) {
    const winner = g.home_score > g.away_score ? g.home_team_id : g.away_team_id;
    if (winner === series.high_seed_team_id) highWins++;
    else lowWins++;
  }
  const winnerTeamId =
    highWins >= WINS_NEEDED ? series.high_seed_team_id : lowWins >= WINS_NEEDED ? series.low_seed_team_id : null;

  if (winnerTeamId !== series.winner_team_id) {
    const { rows: later } = await client.query(
      "SELECT 1 FROM playoff_series WHERE season_number = $1 AND round > $2 LIMIT 1",
      [series.season_number, series.round]
    );
    if (later.length > 0) {
      throw badRequest(
        "That change would alter who won this series, but the next round has already been set. Reset the playoffs to redo it."
      );
    }
  }

  await client.query("UPDATE playoff_series SET high_wins = $1, low_wins = $2, winner_team_id = $3 WHERE id = $4", [
    highWins,
    lowWins,
    winnerTeamId,
    seriesId,
  ]);

  if (winnerTeamId != null) {
    await client.query("DELETE FROM playoff_games WHERE series_id = $1 AND status = 'scheduled'", [seriesId]);
  } else if (!games.some((g) => g.status === "scheduled") && games.length < MAX_GAMES) {
    await createGame(client, series, games.length + 1);
  }

  const { rows: round1 } = await client.query(
    "SELECT COUNT(*)::int AS n FROM playoff_series WHERE season_number = $1 AND round = 1",
    [series.season_number]
  );
  const isFinal = series.round === Math.log2(round1[0].n * 2);
  if (isFinal) {
    // The bracket decides the champion (and takes it back if a correction
    // un-decides the final).
    await client.query(
      `INSERT INTO season_results (season_number, champion_team_id) VALUES ($1, $2)
       ON CONFLICT (season_number) DO UPDATE SET champion_team_id = EXCLUDED.champion_team_id`,
      [series.season_number, winnerTeamId]
    );
  } else if (winnerTeamId != null) {
    await advanceBracket(client, series.season_number);
  }
}

// --- Commissioner actions ---

// teamIds is in seed order: first entry is the #1 seed.
async function setPlayoffField(teamIds) {
  const leaguePhase = await requirePlayoffsPhase();
  const size = await getFieldSize();
  if (!Array.isArray(teamIds) || teamIds.length !== size) {
    throw badRequest(`Pick exactly ${size} playoff teams, in seed order`);
  }
  const ids = teamIds.map(Number);
  if (ids.some((id) => !Number.isInteger(id))) throw badRequest("teamIds must be whole numbers");
  if (new Set(ids).size !== ids.length) throw badRequest("A team can only be in the playoffs once");
  const teamsById = await getTeamsById();
  for (const id of ids) {
    if (!teamsById.has(id)) throw notFound(`Team ${id} not found`);
  }

  const { rows: played } = await pool.query(
    `SELECT 1 FROM playoff_games g JOIN playoff_series s ON s.id = g.series_id
     WHERE s.season_number = $1 AND g.status = 'final' LIMIT 1`,
    [leaguePhase.seasonNumber]
  );
  if (played.length > 0) {
    throw badRequest("Playoff games have already been played — reset the playoffs before changing the field");
  }

  await withTransaction(async (client) => {
    await client.query("DELETE FROM playoff_series WHERE season_number = $1", [leaguePhase.seasonNumber]);
    const order = bracketSeedOrder(size);
    for (let slot = 0; slot < size / 2; slot++) {
      const highSeed = order[slot * 2];
      const lowSeed = order[slot * 2 + 1];
      await createSeries(
        client,
        leaguePhase.seasonNumber,
        1,
        slot,
        { teamId: ids[highSeed - 1], seed: highSeed },
        { teamId: ids[lowSeed - 1], seed: lowSeed }
      );
    }
  });
  return getPlayoffBracket();
}

// Wipes this season's bracket, games and playoff stats so the field can be
// picked again.
async function resetPlayoffs() {
  const leaguePhase = await requirePlayoffsPhase();
  await withTransaction(async (client) => {
    await client.query("DELETE FROM playoff_series WHERE season_number = $1", [leaguePhase.seasonNumber]);
    await client.query("UPDATE players SET playoff_stats = NULL, playoff_console_stats = NULL");
    await client.query("UPDATE season_results SET champion_team_id = NULL WHERE season_number = $1", [
      leaguePhase.seasonNumber,
    ]);
  });
  return getPlayoffBracket();
}

async function loadPlayoffGame(client, gameId) {
  const { rows } = await client.query(
    `SELECT g.*, s.season_number FROM playoff_games g
     JOIN playoff_series s ON s.id = g.series_id WHERE g.id = $1 FOR UPDATE OF g`,
    [Number(gameId)]
  );
  if (rows.length === 0) throw notFound("Playoff game not found");
  return rows[0];
}

const isHumanVsHuman = (game, teamsById) =>
  Boolean(teamsById.get(game.home_team_id)?.isHumanControlled && teamsById.get(game.away_team_id)?.isHumanControlled);

// Console (human vs human) playoff game: just the final score, like the
// regular season. Re-submitting corrects it.
async function submitPlayoffScore(gameId, { wentToOT, homeScore, awayScore }) {
  await requirePlayoffsPhase();
  if (!Number.isInteger(homeScore) || homeScore < 0 || !Number.isInteger(awayScore) || awayScore < 0) {
    throw badRequest("Home and away scores must be non-negative whole numbers");
  }
  if (homeScore === awayScore) {
    throw badRequest("A final score cannot be tied — include the OT winner's goal");
  }
  const teamsById = await getTeamsById();

  await withTransaction(async (client) => {
    const game = await loadPlayoffGame(client, gameId);
    if (!isHumanVsHuman(game, teamsById)) {
      throw badRequest("Only games between two user teams are scored by hand — games with a CPU team are simulated");
    }
    await client.query(
      `UPDATE playoff_games SET status = 'final', home_score = $1, away_score = $2, went_to_ot = $3, source = 'manual'
       WHERE id = $4`,
      [homeScore, awayScore, Boolean(wentToOT), game.id]
    );
    await recomputeSeries(client, game.series_id);
  });
  return getPlayoffBracket();
}

// Loads each player's PLAYOFF stats onto the same `.stats` field the shared
// sim engine (distributeGoals) reads and writes, so playoff games credit
// playoff stats without touching regular-season ones.
async function loadPlayoffStatsOnto(client, teamInfo) {
  const players = teamInfo.goalie ? [...teamInfo.skaters, teamInfo.goalie] : teamInfo.skaters;
  const { rows } = await client.query("SELECT id, playoff_stats FROM players WHERE id = ANY($1)", [
    players.map((p) => p.id),
  ]);
  const byId = new Map(rows.map((r) => [r.id, r.playoff_stats]));
  for (const p of players) p.stats = byId.get(p.id) ?? emptySeasonStats(p.position);
  return players;
}

async function simulateOne(gameId, teamsById) {
  await withTransaction(async (client) => {
    const game = await loadPlayoffGame(client, gameId);
    if (game.status === "final") throw badRequest("That game has already been played");
    if (isHumanVsHuman(game, teamsById)) {
      throw badRequest("Games between two user teams are played on the console and scored by hand, not simulated");
    }

    const home = await teamStrength(client, game.home_team_id);
    const away = await teamStrength(client, game.away_team_id);
    const { homeGoals, awayGoals, wentToOT } = rollGameResult(home, away);

    const homePlayers = await loadPlayoffStatsOnto(client, home);
    const awayPlayers = await loadPlayoffStatsOnto(client, away);
    distributeGoals(home, homeGoals, awayGoals, wentToOT);
    distributeGoals(away, awayGoals, homeGoals, wentToOT);
    for (const p of [...homePlayers, ...awayPlayers]) {
      await client.query("UPDATE players SET playoff_stats = $1 WHERE id = $2", [JSON.stringify(p.stats), p.id]);
    }

    await client.query(
      `UPDATE playoff_games SET status = 'final', home_score = $1, away_score = $2, went_to_ot = $3, source = 'sim'
       WHERE id = $4`,
      [homeGoals, awayGoals, wentToOT, game.id]
    );
    await recomputeSeries(client, game.series_id);
  });
}

async function simulatePlayoffGame(gameId) {
  await requirePlayoffsPhase();
  await simulateOne(gameId, await getTeamsById());
  return getPlayoffBracket();
}

// Plays every game that involves a CPU team, round after round, until only
// console games (or nothing) are left waiting.
async function simulateCpuPlayoffGames() {
  const leaguePhase = await requirePlayoffsPhase();
  const teamsById = await getTeamsById();
  let simmed = 0;
  for (let pass = 0; pass < 100; pass++) {
    const { rows } = await pool.query(
      `SELECT g.* FROM playoff_games g JOIN playoff_series s ON s.id = g.series_id
       WHERE s.season_number = $1 AND g.status = 'scheduled' ORDER BY g.id`,
      [leaguePhase.seasonNumber]
    );
    const due = rows.filter((g) => !isHumanVsHuman(g, teamsById));
    if (due.length === 0) break;
    for (const g of due) {
      await simulateOne(g.id, teamsById);
      simmed++;
    }
  }
  return { simmedCount: simmed, bracket: await getPlayoffBracket() };
}

// --- Reads ---

async function getPlayoffBracket() {
  const [leaguePhase, teamsById] = await Promise.all([store.getLeaguePhase(), getTeamsById()]);
  const seasonNumber = leaguePhase.seasonNumber;
  const [{ rows: seriesRows }, { rows: gameRows }, { rows: resultRows }] = await Promise.all([
    pool.query("SELECT * FROM playoff_series WHERE season_number = $1 ORDER BY round, slot", [seasonNumber]),
    pool.query(
      `SELECT g.* FROM playoff_games g JOIN playoff_series s ON s.id = g.series_id
       WHERE s.season_number = $1 ORDER BY g.series_id, g.game_number`,
      [seasonNumber]
    ),
    pool.query("SELECT champion_team_id FROM season_results WHERE season_number = $1", [seasonNumber]),
  ]);

  const fieldSize = seriesRows.length > 0 ? seriesRows.filter((s) => s.round === 1).length * 2 : await getFieldSize();
  const totalRounds = Math.log2(fieldSize);

  const gamesBySeries = new Map();
  for (const g of gameRows) {
    const game = {
      id: g.id,
      gameNumber: g.game_number,
      homeTeam: teamsById.get(g.home_team_id),
      awayTeam: teamsById.get(g.away_team_id),
      status: g.status,
      homeScore: g.home_score,
      awayScore: g.away_score,
      wentToOT: g.went_to_ot,
      source: g.source,
      gameType: isHumanVsHuman(g, teamsById) ? "human_vs_human" : "simulated",
    };
    if (!gamesBySeries.has(g.series_id)) gamesBySeries.set(g.series_id, []);
    gamesBySeries.get(g.series_id).push(game);
  }

  const shapeSeries = (s) => ({
    id: s.id,
    round: s.round,
    slot: s.slot,
    high: { team: teamsById.get(s.high_seed_team_id), seed: s.high_seed, wins: s.high_wins },
    low: { team: teamsById.get(s.low_seed_team_id), seed: s.low_seed, wins: s.low_wins },
    winner: s.winner_team_id != null ? teamsById.get(s.winner_team_id) : null,
    games: gamesBySeries.get(s.id) ?? [],
  });

  const rounds = [];
  for (let round = 1; round <= totalRounds; round++) {
    const count = fieldSize / 2 ** round;
    const inRound = seriesRows.filter((s) => s.round === round);
    rounds.push({
      round,
      name: roundName(round, totalRounds),
      // null = not decided yet (the earlier round hasn't finished).
      series: Array.from({ length: count }, (_, slot) => {
        const row = inRound.find((s) => s.slot === slot);
        return row ? shapeSeries(row) : null;
      }),
    });
  }

  return {
    seasonNumber,
    phase: leaguePhase.phase,
    fieldSize,
    bestOf: MAX_GAMES,
    started: seriesRows.length > 0,
    rounds,
    champion: resultRows[0]?.champion_team_id != null ? teamsById.get(resultRows[0].champion_team_id) : null,
  };
}

async function getPlayoffStats() {
  const [teamsById, { rows }] = await Promise.all([
    getTeamsById(),
    pool.query(
      "SELECT id, name, position, team_id, playoff_stats FROM players WHERE playoff_stats IS NOT NULL AND team_id IS NOT NULL"
    ),
  ]);
  const played = rows.filter((p) => p.playoff_stats.gamesPlayed > 0);
  const base = (p) => ({
    playerId: p.id,
    name: p.name,
    position: p.position,
    teamId: p.team_id,
    team: teamsById.get(p.team_id),
    gamesPlayed: p.playoff_stats.gamesPlayed,
  });
  return {
    skaters: played
      .filter((p) => p.position !== "G")
      .map((p) => ({
        ...base(p),
        goals: p.playoff_stats.goals,
        assists: p.playoff_stats.assists,
        points: p.playoff_stats.points,
      }))
      .sort((a, b) => b.points - a.points || b.goals - a.goals),
    goalies: played
      .filter((p) => p.position === "G")
      .map((p) => ({
        ...base(p),
        wins: p.playoff_stats.wins,
        losses: p.playoff_stats.losses,
        otLosses: p.playoff_stats.otLosses,
        goalsAgainstAverage: p.playoff_stats.goalsAgainstAverage,
        savePercentage: p.playoff_stats.savePercentage,
        shutouts: p.playoff_stats.shutouts,
      }))
      .sort((a, b) => b.wins - a.wins || b.savePercentage - a.savePercentage),
  };
}

// --- Console playoff stats (commissioner enters running totals) ---

// Each human playoff team's scored console playoff games and goals for in
// them — the cap and sanity check for what's entered, as in store.js.
async function consolePlayoffTotals() {
  const [teamsById, seasonNumber] = await Promise.all([getTeamsById(), getSeasonNumber()]);
  const { rows } = await pool.query(
    `SELECT g.* FROM playoff_games g JOIN playoff_series s ON s.id = g.series_id
     WHERE s.season_number = $1 AND g.status = 'final'`,
    [seasonNumber]
  );
  const totals = new Map();
  for (const g of rows.filter((x) => isHumanVsHuman(x, teamsById))) {
    for (const [teamId, goalsFor] of [
      [g.home_team_id, g.home_score],
      [g.away_team_id, g.away_score],
    ]) {
      const t = totals.get(teamId) ?? { userGamesPlayed: 0, goalsFor: 0 };
      t.userGamesPlayed += 1;
      t.goalsFor += goalsFor;
      totals.set(teamId, t);
    }
  }
  return totals;
}

async function getPlayoffUserGameStats() {
  const seasonNumber = await getSeasonNumber();
  const [teams, players, totals, { rows: consoleRows }, { rows: seriesRows }] = await Promise.all([
    store.getTeams(),
    store.getPlayers(),
    consolePlayoffTotals(),
    pool.query("SELECT id, playoff_console_stats FROM players WHERE playoff_console_stats IS NOT NULL"),
    pool.query("SELECT high_seed_team_id, low_seed_team_id FROM playoff_series WHERE season_number = $1", [
      seasonNumber,
    ]),
  ]);
  const consoleById = new Map(consoleRows.map((r) => [r.id, r.playoff_console_stats]));
  const inPlayoffs = new Set(seriesRows.flatMap((s) => [s.high_seed_team_id, s.low_seed_team_id]));

  return teams
    .filter((t) => t.isHumanControlled && inPlayoffs.has(t.id))
    .map((team) => ({
      team,
      userGamesPlayed: totals.get(team.id)?.userGamesPlayed ?? 0,
      goalsFor: totals.get(team.id)?.goalsFor ?? 0,
      players: players
        .filter((p) => p.teamId === team.id && (p.lineupSlot !== "MINORS" || consoleById.has(p.id)))
        .sort((a, b) => b.overall - a.overall)
        .map((p) => ({
          id: p.id,
          name: p.name,
          position: p.position,
          overall: p.overall,
          lineupSlot: p.lineupSlot,
          consoleStats: consoleById.get(p.id) ?? zeroConsoleStats(p.position),
        })),
    }));
}

async function savePlayoffUserGameStats(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw badRequest("entries must be a non-empty array");

  const [teamsById, totals, { rows }] = await Promise.all([
    getTeamsById(),
    consolePlayoffTotals(),
    pool.query(
      "SELECT id, name, team_id, position, playoff_stats, playoff_console_stats FROM players WHERE id = ANY($1)",
      [entries.map((e) => Number(e.playerId))]
    ),
  ]);
  const playersById = new Map(rows.map((p) => [p.id, p]));

  const prepared = entries.map((entry) => {
    const player = playersById.get(Number(entry.playerId));
    if (!player) throw notFound(`Player ${entry.playerId} not found`);
    const team = teamsById.get(player.team_id);
    if (!team?.isHumanControlled) throw badRequest(`${player.name} isn't on a human-controlled team`);

    let next;
    try {
      next = normalizeConsoleEntry(player.position, entry);
    } catch (err) {
      throw badRequest(`${player.name}: ${err.message}`);
    }
    const cap = totals.get(team.id)?.userGamesPlayed ?? 0;
    if (next.gamesPlayed > cap) {
      throw badRequest(
        `${player.name}: ${next.gamesPlayed} games played is more than the ${cap} user playoff game(s) scored for ${team.city} ${team.name}`
      );
    }
    return { player, next };
  });

  await withTransaction(async (client) => {
    for (const { player, next } of prepared) {
      const prev = player.playoff_console_stats ?? zeroConsoleStats(player.position);
      const stats = player.playoff_stats ?? emptySeasonStats(player.position);
      applyConsoleStatsDelta(stats, player.position, prev, next);
      await client.query("UPDATE players SET playoff_stats = $1, playoff_console_stats = $2 WHERE id = $3", [
        JSON.stringify(stats),
        JSON.stringify(next),
        player.id,
      ]);
    }
  });

  return getPlayoffUserGameStats();
}

module.exports = {
  getPlayoffBracket,
  getPlayoffStats,
  setPlayoffField,
  resetPlayoffs,
  submitPlayoffScore,
  simulatePlayoffGame,
  simulateCpuPlayoffGames,
  getPlayoffUserGameStats,
  savePlayoffUserGameStats,
};

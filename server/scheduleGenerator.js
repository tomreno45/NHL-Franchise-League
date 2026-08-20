// Balanced round-robin generator using the circle method: fix one team,
// rotate the rest each round so every team plays every other team exactly
// once per single pass. A "matchup" always comes in home+away pairs so the
// schedule never favors one side.

function circleMethodSingleRoundRobin(teamIds) {
  const n = teamIds.length;
  const fixed = teamIds[0];
  const rotating = teamIds.slice(1);
  const rounds = [];

  for (let r = 0; r < n - 1; r++) {
    const arranged = [fixed, ...rotating];
    const pairings = [];
    for (let i = 0; i < n / 2; i++) {
      let home = arranged[i];
      let away = arranged[n - 1 - i];
      if (r % 2 === 1) [home, away] = [away, home]; // spread home games evenly for the fixed team too
      pairings.push({ homeTeamId: home, awayTeamId: away });
    }
    rounds.push(pairings);
    rotating.unshift(rotating.pop());
  }
  return rounds;
}

function buildGame(homeTeamId, awayTeamId, dateStr) {
  return {
    date: dateStr,
    homeTeamId,
    awayTeamId,
    status: "scheduled",
    homeScore: null,
    awayScore: null,
    wentToOT: false,
    source: null,
  };
}

function generateRoundRobinSchedule(teamIds, { startDate, roundsPerMatchup = 2, daysBetweenRounds = 3 }) {
  if (teamIds.length % 2 !== 0) {
    const err = new Error("Schedule generator requires an even number of teams");
    err.status = 400;
    throw err;
  }
  if (!Number.isInteger(roundsPerMatchup) || roundsPerMatchup < 2 || roundsPerMatchup % 2 !== 0) {
    const err = new Error("roundsPerMatchup must be an even integer >= 2 (equal home/away meetings)");
    err.status = 400;
    throw err;
  }

  const singlePass = circleMethodSingleRoundRobin(teamIds);
  const mirroredPass = singlePass.map((round) =>
    round.map(({ homeTeamId, awayTeamId }) => ({ homeTeamId: awayTeamId, awayTeamId: homeTeamId }))
  );

  const rounds = [];
  for (let block = 0; block < roundsPerMatchup / 2; block++) {
    rounds.push(...singlePass, ...mirroredPass);
  }

  const games = [];
  const start = new Date(startDate);
  rounds.forEach((pairings, roundIndex) => {
    const date = new Date(start);
    date.setDate(date.getDate() + roundIndex * daysBetweenRounds);
    const dateStr = date.toISOString().slice(0, 10);
    pairings.forEach(({ homeTeamId, awayTeamId }) => games.push(buildGame(homeTeamId, awayTeamId, dateStr)));
  });

  return games;
}

function pairKey(a, b) {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

// Builds a full season on top of generateRoundRobinSchedule's base
// round-robin: every pair meets `baseMeetings` times (2, same as before),
// human-vs-human pairs get bumped up to `humanMeetings` (the featured
// rivalry deserves more head-to-head games than a 32-team round robin alone
// would ever give it — at baseMeetings=2 the two human GMs would otherwise
// only play each other twice all season), and then every team's remaining
// games up to `targetGamesPerTeam` get spread across its *other* (CPU)
// opponents. 31 possible opponents doesn't divide evenly into most target
// totals (84 included), so this is deliberately uneven — some opponents get
// one extra meeting, most don't — the same way a real NHL schedule isn't a
// clean multiple of anything either.
function generateNhlStyleSchedule(
  teams,
  { startDate, daysBetweenRounds = 3, targetGamesPerTeam = 84, humanMeetings = 3, baseMeetings = 2 } = {}
) {
  const teamIds = teams.map((t) => t.id);
  const humanIds = new Set(teams.filter((t) => t.isHumanControlled).map((t) => t.id));
  const maxMeetingsPerPair = baseMeetings + 2; // keeps the "extra" spread from piling onto the same couple of teams

  // --- 1. Base layer: everyone meets everyone `baseMeetings` times ---
  const baseGames = generateRoundRobinSchedule(teamIds, { startDate, roundsPerMatchup: baseMeetings, daysBetweenRounds });

  const meetingsByPair = new Map();
  const gamesByTeam = new Map(teamIds.map((id) => [id, 0]));
  const homeGamesByTeam = new Map(teamIds.map((id) => [id, 0]));
  for (const g of baseGames) {
    const key = pairKey(g.homeTeamId, g.awayTeamId);
    meetingsByPair.set(key, (meetingsByPair.get(key) || 0) + 1);
    gamesByTeam.set(g.homeTeamId, gamesByTeam.get(g.homeTeamId) + 1);
    gamesByTeam.set(g.awayTeamId, gamesByTeam.get(g.awayTeamId) + 1);
    homeGamesByTeam.set(g.homeTeamId, homeGamesByTeam.get(g.homeTeamId) + 1);
  }

  const closedPairs = new Set(); // human-vs-human pairs — never topped up beyond humanMeetings
  const extraFixtures = []; // [homeTeamId, awayTeamId][] — dates assigned later, after round-packing

  // --- 2. Elevate every human-vs-human pair to `humanMeetings` ---
  for (const a of teams) {
    if (!humanIds.has(a.id)) continue;
    for (const b of teams) {
      if (b.id <= a.id || !humanIds.has(b.id)) continue;
      const key = pairKey(a.id, b.id);
      closedPairs.add(key);
      let extra = humanMeetings - (meetingsByPair.get(key) || 0);
      while (extra > 0) {
        // Whoever has fewer home games so far this season hosts — keeps the
        // odd (3rd, 5th, ...) meeting from always favoring the same side.
        const home = homeGamesByTeam.get(a.id) <= homeGamesByTeam.get(b.id) ? a.id : b.id;
        const away = home === a.id ? b.id : a.id;
        extraFixtures.push([home, away]);
        meetingsByPair.set(key, (meetingsByPair.get(key) || 0) + 1);
        gamesByTeam.set(a.id, gamesByTeam.get(a.id) + 1);
        gamesByTeam.set(b.id, gamesByTeam.get(b.id) + 1);
        homeGamesByTeam.set(home, homeGamesByTeam.get(home) + 1);
        extra--;
      }
    }
  }

  // --- 3. Spread everyone's remaining games across their CPU opponents ---
  // Greedy: repeatedly pair whichever two (still-open) teams need the most
  // games. With every team needing roughly the same amount (21-22 here),
  // this settles into a fairly even spread rather than concentrating extra
  // meetings on a handful of opponents.
  const need = new Map(teamIds.map((id) => [id, targetGamesPerTeam - gamesByTeam.get(id)]));
  const totalNeed = () => teamIds.reduce((sum, id) => sum + Math.max(0, need.get(id)), 0);

  let guard = 0;
  while (totalNeed() > 0) {
    guard++;
    if (guard > teamIds.length * targetGamesPerTeam * 4) {
      const err = new Error("generateNhlStyleSchedule couldn't fully balance the schedule — check the target/team counts");
      err.status = 500;
      throw err;
    }

    const needing = teamIds.filter((id) => need.get(id) > 0).sort((x, y) => need.get(y) - need.get(x));
    if (needing.length === 0) break;

    let paired = false;
    for (let i = 0; i < needing.length && !paired; i++) {
      const a = needing[i];
      for (let j = i + 1; j < needing.length; j++) {
        const b = needing[j];
        const key = pairKey(a, b);
        if (closedPairs.has(key)) continue;
        if ((meetingsByPair.get(key) || 0) >= maxMeetingsPerPair) continue;

        const home = homeGamesByTeam.get(a) <= homeGamesByTeam.get(b) ? a : b;
        const away = home === a ? b : a;
        extraFixtures.push([home, away]);
        meetingsByPair.set(key, (meetingsByPair.get(key) || 0) + 1);
        gamesByTeam.set(a, gamesByTeam.get(a) + 1);
        gamesByTeam.set(b, gamesByTeam.get(b) + 1);
        homeGamesByTeam.set(home, homeGamesByTeam.get(home) + 1);
        need.set(a, need.get(a) - 1);
        need.set(b, need.get(b) - 1);
        paired = true;
        break;
      }
    }

    if (!paired) {
      // Every remaining pair among the teams that still need games is
      // already at the per-pair cap — loosen it rather than leaving anyone
      // short a game.
      for (let i = 0; i < needing.length && !paired; i++) {
        const a = needing[i];
        for (let j = i + 1; j < needing.length; j++) {
          const b = needing[j];
          const key = pairKey(a, b);
          if (closedPairs.has(key)) continue;
          const home = homeGamesByTeam.get(a) <= homeGamesByTeam.get(b) ? a : b;
          const away = home === a ? b : a;
          extraFixtures.push([home, away]);
          meetingsByPair.set(key, (meetingsByPair.get(key) || 0) + 1);
          gamesByTeam.set(a, gamesByTeam.get(a) + 1);
          gamesByTeam.set(b, gamesByTeam.get(b) + 1);
          homeGamesByTeam.set(home, homeGamesByTeam.get(home) + 1);
          need.set(a, need.get(a) - 1);
          need.set(b, need.get(b) - 1);
          paired = true;
          break;
        }
      }
    }

    if (!paired) {
      const err = new Error("generateNhlStyleSchedule got stuck balancing the schedule — check the target/team counts");
      err.status = 500;
      throw err;
    }
  }

  // --- 4. Pack the extra fixtures into rounds (no team plays twice a day), ---
  //         continuing the date sequence right after the base schedule.
  const extraRounds = [];
  for (const [home, away] of extraFixtures) {
    let round = extraRounds.find((r) => !r.teams.has(home) && !r.teams.has(away));
    if (!round) {
      round = { teams: new Set(), games: [] };
      extraRounds.push(round);
    }
    round.teams.add(home);
    round.teams.add(away);
    round.games.push({ homeTeamId: home, awayTeamId: away });
  }

  const lastBaseDate = new Date(baseGames[baseGames.length - 1].date);
  const extraGames = [];
  extraRounds.forEach((round, roundIndex) => {
    const date = new Date(lastBaseDate);
    date.setDate(date.getDate() + (roundIndex + 1) * daysBetweenRounds);
    const dateStr = date.toISOString().slice(0, 10);
    round.games.forEach(({ homeTeamId, awayTeamId }) => extraGames.push(buildGame(homeTeamId, awayTeamId, dateStr)));
  });

  return [...baseGames, ...extraGames];
}

module.exports = { generateRoundRobinSchedule, generateNhlStyleSchedule };

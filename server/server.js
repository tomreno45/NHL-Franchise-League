const path = require("path");
const express = require("express");
const cors = require("cors");
const session = require("express-session");
const pgSessionStore = require("connect-pg-simple")(session);
const store = require("./store");
const { initDatabase } = require("./seed");
const { sessionPool, runWithLeague, LEAGUE_SLUGS, LEAGUES } = require("./db");

const app = express();
const PORT = process.env.PORT || 4000;
const isProduction = process.env.NODE_ENV === "production";

// Deployed behind Railway's TLS-terminating proxy — the app itself only
// ever sees plain HTTP internally, so without this Express can't tell the
// connection was actually HTTPS and a `secure` cookie (below) would never
// get set. Harmless locally (no proxy in front of `node server.js` in dev).
if (isProduction) app.set("trust proxy", 1);

// credentials: true + an explicit origin (not "*") is required for the
// session cookie to actually reach the browser when client and server are
// on different origins (local dev, via the Vite proxy). In production the
// server serves the built client itself (see the static block below) —
// same-origin, so CORS doesn't come into play there at all.
app.use(cors({ origin: process.env.CLIENT_ORIGIN || "http://localhost:5173", credentials: true }));
app.use(express.json());

app.use(
  session({
    // Always the same fixed database regardless of which league a session
    // ends up choosing — see db.js's sessionPool comment.
    store: new pgSessionStore({ pool: sessionPool, createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      // A `secure` cookie is silently dropped by the browser over plain
      // http, which is all local dev has — only require it once actually
      // served over HTTPS in production.
      secure: isProduction,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 30,
    },
  })
);

// Establishes which league's database every store.js call in this request
// should hit, based on the league chosen at login (see /api/auth/login).
// Runs for every route, including the pre-auth ones — it's a no-op until
// req.session.leagueSlug exists, which is fine since the only pre-auth
// routes that touch the DB (login itself) establish their own league
// context explicitly rather than relying on this.
app.use((req, res, next) => {
  const slug = req.session?.leagueSlug;
  if (slug && LEAGUE_SLUGS.includes(slug)) {
    runWithLeague(slug, next);
  } else {
    next();
  }
});

// Wraps an async route handler so a thrown/rejected error reaches Express's
// error middleware instead of crashing the process.
function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

// Minimal CSV parser (handles quoted fields with embedded commas) for draft
// class imports — small and controlled enough not to warrant a dependency.
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];

  const splitLine = (line) => {
    const cells = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        cells.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    cells.push(cur);
    return cells.map((c) => c.trim());
  };

  const headers = splitLine(lines[0]).map((h) => h.toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = splitLine(line);
    const row = {};
    headers.forEach((h, i) => {
      row[h] = cells[i] ?? "";
    });
    return row;
  });
}

// Maps a raw parsed CSV row (lowercase header keys) to the shape
// store.importDraftClass expects, accepting a few friendly header aliases.
function toImportRow(raw) {
  const pick = (...keys) => keys.map((k) => raw[k]).find((v) => v !== undefined && v !== "");
  const heightRaw = pick("heightinches", "height_inches", "height");
  const weightRaw = pick("weightlbs", "weight_lbs", "weight");
  return {
    name: pick("name"),
    position: pick("position", "pos"),
    nationality: pick("nationality", "country"),
    heightInches: heightRaw ? Number(heightRaw) : undefined,
    weightLbs: weightRaw ? Number(weightRaw) : undefined,
  };
}

// The set of parallel league copies to choose from at login — see db.js's
// LEAGUES. Public, no session required, since the login form needs it
// before any session exists.
app.get("/api/leagues", (req, res) => {
  res.json(LEAGUE_SLUGS.map((slug) => ({ slug, label: LEAGUES[slug].label })));
});

// No public signup — accounts are created invite-only via
// server/scripts/createUser.js (run once per league; the same username can
// exist independently in each). These four routes are the only ones that
// work without a session already established.
app.post(
  "/api/auth/login",
  asyncRoute(async (req, res) => {
    const { league, username, password } = req.body;
    if (!LEAGUE_SLUGS.includes(league)) {
      return res.status(400).json({ error: "Unknown league" });
    }
    const user = await runWithLeague(league, () => store.verifyLogin(username, password));
    if (!user) {
      return res.status(401).json({ error: "Invalid username or password" });
    }
    req.session.userId = user.id;
    req.session.teamId = user.teamId;
    req.session.leagueSlug = league;
    req.session.role = user.role;
    res.json({ ...user, league: { slug: league, label: LEAGUES[league].label } });
  })
);

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

app.get(
  "/api/auth/me",
  asyncRoute(async (req, res) => {
    if (!req.session.userId || !req.session.leagueSlug) {
      return res.status(401).json({ error: "Not logged in" });
    }
    const user = await store.getUserById(req.session.userId);
    if (!user) {
      // The account was deleted out from under an existing session.
      return req.session.destroy(() => res.status(401).json({ error: "Not logged in" }));
    }
    res.json({ ...user, league: { slug: req.session.leagueSlug, label: LEAGUES[req.session.leagueSlug].label } });
  })
);

// Serves the built React client (client/dist, produced by `npm run build`)
// so this one process is the whole deployed app — no separate static host,
// no cross-origin cookie complications. Only wired up in production; local
// dev keeps using Vite's own dev server on :5173 with its own proxy. Has to
// sit before requireAuth below — the login page's own HTML/JS/CSS must be
// reachable without a session, or nobody could ever load the app to log in.
// The SPA fallback's negative-lookahead regex keeps it from ever matching
// an /api/* path (so an unmatched API route still 404s instead of getting
// swallowed into a confusing 200 of index.html), regardless of where the
// real /api routes are registered relative to this.
if (isProduction) {
  const clientDist = path.join(__dirname, "..", "client", "dist");
  app.use(express.static(clientDist));
  app.get(/^(?!\/api\/).*/, (req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

// Everything below this line requires a logged-in session (with a league
// chosen — the two are set together at login, so missing either means the
// session is incomplete/stale).
function requireAuth(req, res, next) {
  if (!req.session.userId || !req.session.leagueSlug) {
    return res.status(401).json({ error: "Not logged in" });
  }
  next();
}
app.use(requireAuth);

// For routes that act "as" a team (submitting a bid, proposing a trade,
// setting a lineup, etc.) — forces the acting team to whichever team this
// session's user actually controls, never a client-supplied id, so one GM
// can no longer act on another team's behalf just by passing a different
// teamId. A commissioner-only account (team_id null) can't use these.
function requireTeam(req, res, next) {
  if (req.session.teamId == null) {
    return res.status(403).json({ error: "This account isn't assigned to a team" });
  }
  req.teamId = req.session.teamId;
  next();
}

// For the league-wide actions only the commissioner should be able to
// trigger (advancing the season's phase/date, crowning a champion,
// overriding the draft order, regenerating the draft class). A normal GM
// account can still see all the read-only state these actions affect —
// this only blocks the mutations.
function requireCommissioner(req, res, next) {
  if (req.session.role !== "commissioner") {
    return res.status(403).json({ error: "Commissioner only" });
  }
  next();
}

app.get(
  "/api/standings",
  asyncRoute(async (req, res) => {
    res.json(await store.getStandings());
  })
);

app.get(
  "/api/teams",
  asyncRoute(async (req, res) => {
    res.json(await store.getTeams());
  })
);

app.get(
  "/api/teams/:id/roster",
  asyncRoute(async (req, res) => {
    const teamId = Number(req.params.id);
    const teams = await store.getTeams();
    const team = teams.find((t) => t.id === teamId);
    if (!team) {
      return res.status(404).json({ error: "Team not found" });
    }
    const [roster, capSummary] = await Promise.all([
      store.getPlayersByTeam(teamId).then((players) => players.sort((a, b) => a.jerseyNumber - b.jerseyNumber)),
      store.getTeamCapSummary(teamId),
    ]);
    res.json({ team, roster, capSummary });
  })
);

// Lightweight cap-only lookup — Free Agency and Re-Signing need a team's
// cap space without pulling its whole roster.
app.get(
  "/api/teams/:id/cap",
  asyncRoute(async (req, res) => {
    const teamId = Number(req.params.id);
    const teams = await store.getTeams();
    if (!teams.some((t) => t.id === teamId)) {
      return res.status(404).json({ error: "Team not found" });
    }
    res.json(await store.getTeamCapSummary(teamId));
  })
);

// Verbose (Very Low..Very High) acquisition need per asset category
// (forwards/defense/goalies/draft picks) — same computeTeamNeeds() driving
// CPU free agency/trade behavior, just labeled for a human GM to read in
// Trade Center rather than the raw 0..1 score.
app.get(
  "/api/teams/:id/needs",
  asyncRoute(async (req, res) => {
    const teamId = Number(req.params.id);
    const teams = await store.getTeams();
    if (!teams.some((t) => t.id === teamId)) {
      return res.status(404).json({ error: "Team not found" });
    }
    res.json(await store.getTeamNeeds(teamId));
  })
);

app.get(
  "/api/schedule",
  asyncRoute(async (req, res) => {
    const teamId = req.query.teamId ? Number(req.query.teamId) : undefined;
    res.json(await store.getGames({ teamId }));
  })
);

// Games awaiting a score, i.e. human_vs_human matchups that were supposed to
// be played on console by now but haven't been reported back yet.
app.get(
  "/api/games/pending",
  asyncRoute(async (req, res) => {
    res.json(await store.getPendingHumanGames());
  })
);

// Manual box-score entry for human_vs_human games played on the console —
// the final score is derived from the submitted goals, not entered
// separately. Re-submitting an already-scored game cleanly corrects it
// (store.submitScore reverses the previous submission first).
app.put(
  "/api/games/:id/score",
  asyncRoute(async (req, res) => {
    const { wentToOT, home, away } = req.body;
    const game = await store.submitScore(req.params.id, { wentToOT, home, away });
    res.json(game);
  })
);

// Catch-up simulation for human_vs_cpu / cpu_vs_cpu games that are due.
app.post(
  "/api/sim/advance",
  asyncRoute(async (req, res) => {
    const simmed = await store.advanceSimulation();
    res.json({ simmedCount: simmed.length, games: simmed });
  })
);

// The commissioner action for "once all games are played in NHL 27" —
// simulates every remaining CPU-involved game regardless of date, but
// refuses if any human-vs-human game is still unscored.
app.post(
  "/api/sim/advance-all",
  requireCommissioner,
  asyncRoute(async (req, res) => {
    res.json(await store.simulateAllRemainingGames());
  })
);

app.get(
  "/api/season",
  asyncRoute(async (req, res) => {
    res.json(await store.getSeasonInfo());
  })
);

// Moves the league's own clock forward (independent of wall-clock time) and
// auto-sims any CPU-involved games that become due as a result.
app.post(
  "/api/league/advance-date",
  requireCommissioner,
  asyncRoute(async (req, res) => {
    const result = await store.advanceLeagueDate(Number(req.body.days));
    res.json(result);
  })
);

// Records this season's playoff winner — no bracket/qualification logic
// yet, per the user's own "just select the winner for now."
app.post(
  "/api/playoffs/champion",
  requireCommissioner,
  asyncRoute(async (req, res) => {
    res.json(await store.setPlayoffChampion({ teamId: Number(req.body.teamId) }));
  })
);

// Every recorded season's champion, most recent first.
app.get(
  "/api/playoffs/results",
  asyncRoute(async (req, res) => {
    res.json(await store.getSeasonResults());
  })
);

// The 20 fixed line-editor slots (4 forward lines x LW/C/RW, 3 defense
// pairs, starter/backup goalie) plus the scratch/minors bucket names —
// static, but served from here so the client never hardcodes a second copy.
app.get(
  "/api/lineup/slots",
  asyncRoute(async (req, res) => {
    res.json(await store.getLineupSlots());
  })
);

// Moves one player to `targetSlot` — only allowed during the `set_roster`
// phase, and only by the team that owns the player. If targetSlot is a
// unique slot someone else already holds, that player is automatically
// swapped into the mover's old slot (see store.js's assignLineupSlot).
app.post(
  "/api/lineup/assign",
  requireTeam,
  asyncRoute(async (req, res) => {
    const { playerId, targetSlot } = req.body;
    res.json(
      await store.assignLineupSlot({
        teamId: req.teamId,
        playerId: Number(playerId),
        targetSlot,
      })
    );
  })
);

// Players (per human team) whose NHL 27 card is out of date and needs the
// commissioner to apply the change in-console. Clearing this list and
// generating the season's schedule both happen automatically when the
// commissioner advances out of the `roster_update` phase.
app.get(
  "/api/commissioner/roster-changes",
  asyncRoute(async (req, res) => {
    res.json(await store.getRosterChanges());
  })
);

// Everything currently in motion across every human team — free agent
// bids, re-sign offers, and pending trades (both to other humans and to
// CPU teams) for the live round. No privacy scoping, unlike the per-team
// MyGM > Pending Moves view — the commissioner sees everyone's.
app.get(
  "/api/commissioner/pending-moves",
  requireCommissioner,
  asyncRoute(async (req, res) => {
    res.json(await store.getLeagueWidePendingMoves());
  })
);

// Every login account in this league (no password hashes — see store.js's
// mapUserRow) — open to any logged-in user, not just the commissioner
// (backs both the MyGM > User List tab everyone sees, and the Commissioner
// tab's own management table).
app.get(
  "/api/users",
  asyncRoute(async (req, res) => {
    res.json(await store.getUsers());
  })
);

// Creates a new login account in this league. The only way to do this used
// to be the standalone createUser.js CLI script (still there, still works,
// but requires shell access + knowing which LEAGUE env var to set) — this
// is the same store.createUser call, just reachable from the Commissioner
// tab so adding a GM or a second commissioner doesn't need a terminal.
app.post(
  "/api/commissioner/users",
  requireCommissioner,
  asyncRoute(async (req, res) => {
    const { username, password, displayName, teamId, role } = req.body;
    const user = await store.createUser({
      username,
      password,
      displayName,
      teamId: teamId ? Number(teamId) : null,
      role,
    });
    res.status(201).json(user);
  })
);

// Removes a login account. store.deleteUser refuses to delete the caller's
// own account (would lock the commissioner out mid-session) or the last
// remaining commissioner account (nobody left to manage the league).
app.delete(
  "/api/commissioner/users/:id",
  requireCommissioner,
  asyncRoute(async (req, res) => {
    res.json(await store.deleteUser(Number(req.params.id), { requestingUserId: req.session.userId }));
  })
);

// Where the league currently sits in the season pipeline (free agency ->
// trades -> roster lock -> ... -> re-signing -> loop). See store.js's
// PHASE_SEQUENCE for the full ordered list.
app.get(
  "/api/league/phase",
  asyncRoute(async (req, res) => {
    res.json(await store.getLeaguePhase());
  })
);

// The one commissioner action that resolves the current phase's round (once
// that phase has real resolution logic) and moves the league to the next
// round/phase, looping into a new season after re-signing's last round.
app.post(
  "/api/league/phase/advance",
  requireCommissioner,
  asyncRoute(async (req, res) => {
    res.json(await store.advanceLeaguePhase());
  })
);

// Every human-controlled team's ready/not-ready state for the current
// phase/round — visible to everyone, not just the acting team, so the
// whole league can see who's still holding things up.
app.get(
  "/api/league/ready",
  asyncRoute(async (req, res) => {
    res.json(await store.getReadyStatus());
  })
);

// Marks (or unmarks) the requesting team ready for the current checkpoint.
// Auto-advances the phase once every human team is ready — see
// store.js's setTeamReady for what happens if the phase's own exit
// condition (games remaining, draft unfinished, etc.) isn't actually met
// yet even once everyone's readied up.
app.post(
  "/api/league/ready",
  requireTeam,
  asyncRoute(async (req, res) => {
    res.json(await store.setTeamReady(req.teamId, Boolean(req.body.ready)));
  })
);

// Current free agents plus the requesting team's own bid on each — open
// during both `free_agency` and `trade_period` phases. Scoped to ?teamId=
// so a GM only ever sees their own bid, never a competitor's.
app.get(
  "/api/freeagency/board",
  requireTeam,
  asyncRoute(async (req, res) => {
    res.json(await store.getFreeAgencyBoard(req.teamId));
  })
);

// Submits (or revises, same team/player/round) a bid. Resolved automatically
// when the commissioner advances the phase.
app.post(
  "/api/freeagency/bids",
  requireTeam,
  asyncRoute(async (req, res) => {
    const { playerId, aavMillions, years } = req.body;
    res.json(
      await store.submitFreeAgentBid({
        teamId: req.teamId,
        playerId: Number(playerId),
        aavMillions: Number(aavMillions),
        years: Number(years),
      })
    );
  })
);

// Players on human rosters with an expiring contract (contractYearsLeft <=
// 1) plus any offer already on the table this round.
app.get(
  "/api/resigning/board",
  asyncRoute(async (req, res) => {
    res.json(await store.getResigningBoard());
  })
);

// A team's exclusive offer to its own pending free agent. Resolved
// automatically when the commissioner advances the phase.
app.post(
  "/api/resigning/offers",
  requireTeam,
  asyncRoute(async (req, res) => {
    const { playerId, aavMillions, years } = req.body;
    res.json(
      await store.submitResignOffer({
        teamId: req.teamId,
        playerId: Number(playerId),
        aavMillions: Number(aavMillions),
        years: Number(years),
      })
    );
  })
);

// No server-side limit/sort beyond a sane default — the Stats page fetches
// the full (optionally team-filtered) list once and does sort-by-column
// itself, so switching the sort field never has to re-fetch or risk
// excluding someone who'd only rank highly under a different stat.
app.get(
  "/api/scorers",
  asyncRoute(async (req, res) => {
    const teamId = req.query.teamId ? Number(req.query.teamId) : undefined;
    res.json(await store.getScorers({ teamId }));
  })
);

app.get(
  "/api/goalies",
  asyncRoute(async (req, res) => {
    const teamId = req.query.teamId ? Number(req.query.teamId) : undefined;
    res.json(await store.getGoalieLeaders({ teamId }));
  })
);

// Runs the offseason progression engine over every player, returns a
// per-human-team change sheet, and resets season stats for the next season.
app.post(
  "/api/progression/run",
  asyncRoute(async (req, res) => {
    res.json(await store.runProgression());
  })
);

app.get(
  "/api/progression/latest",
  asyncRoute(async (req, res) => {
    const result = await store.getLatestProgression();
    if (!result) {
      return res.status(404).json({ error: "Progression has not been run yet" });
    }
    res.json(result);
  })
);

// Draft picks for the current season's upcoming draft, with trade value
// computed live from each pick's original team's projected draft slot.
// Optional ?teamId= filters to who currently holds each pick (post-trades).
app.get(
  "/api/draft/picks",
  asyncRoute(async (req, res) => {
    const teamId = req.query.teamId ? Number(req.query.teamId) : undefined;
    res.json(await store.getDraftPicks({ teamId }));
  })
);

// This season's draft order — a commissioner-saved override if one exists,
// otherwise the live standings/roster projection with the champion forced
// last. See store.js's draft_order override section for why this can't
// just be computed from standings alone (real playoffs happen on the NHL 27
// console, not in this app).
app.get(
  "/api/draft/order",
  asyncRoute(async (req, res) => {
    const season = await store.getSeasonInfo();
    res.json(await store.getDraftOrder(season.seasonNumber));
  })
);

// Commissioner-only adjustment of the current season's draft order, meant
// to be used once real NHL 27 console playoff results are known (see
// store.js's setDraftOrder for the phase/current-pick-index guards).
app.post(
  "/api/draft/order",
  requireCommissioner,
  asyncRoute(async (req, res) => {
    const season = await store.getSeasonInfo();
    res.json(await store.setDraftOrder(season.seasonNumber, req.body.teamIds));
  })
);

// Current season's public draft board — name/position/nationality/height/
// weight/rank only. The rank is deliberately noisy (see store.js), never a
// clean sort of hidden overall/potential, so real busts and gems exist.
app.get(
  "/api/draft/class",
  asyncRoute(async (req, res) => {
    const season = await store.getSeasonInfo();
    res.json(await store.getDraftClass(season.seasonNumber));
  })
);

// Replaces the current season's prospect pool with a freshly random one.
// Blocked once the draft phase has started — regenerating the board out
// from under an in-progress draft would invalidate whatever's already been
// picked from it. Gated here at the route level (not inside the store
// function) since the phase machine's own internal callers — the
// free_agency loop-around and the startup backfill in seed.js — always
// call this well outside the draft phase and shouldn't need to reason
// about it.
app.post(
  "/api/draft/class/generate",
  requireCommissioner,
  asyncRoute(async (req, res) => {
    const leaguePhase = await store.getLeaguePhase();
    if (leaguePhase.phase === "draft") {
      return res.status(400).json({ error: "Can't regenerate the draft class while the draft is in progress" });
    }
    const count = req.body?.count ? Number(req.body.count) : undefined;
    res.json(await store.generateRandomDraftClass(leaguePhase.seasonNumber, count));
  })
);

// Replaces the current season's prospect pool with a user-supplied one.
// Only name/position/nationality/height/weight can come from the CSV —
// hidden overall/potential (and therefore rank) are always freshly rolled
// by the game, generated or imported alike. Same in-progress-draft guard
// as generate, above.
app.post(
  "/api/draft/class/import",
  requireCommissioner,
  asyncRoute(async (req, res) => {
    const { csvText } = req.body;
    if (!csvText || !csvText.trim()) {
      return res.status(400).json({ error: "csvText is required" });
    }
    const leaguePhase = await store.getLeaguePhase();
    if (leaguePhase.phase === "draft") {
      return res.status(400).json({ error: "Can't import a draft class while the draft is in progress" });
    }
    const rows = parseCsv(csvText).map(toImportRow);
    res.json(await store.importDraftClass(leaguePhase.seasonNumber, rows));
  })
);

// Whose turn it is right now, and how many picks remain.
app.get(
  "/api/draft/status",
  asyncRoute(async (req, res) => {
    res.json(await store.getDraftStatus());
  })
);

// Resumes the auto-pick loop for any consecutive CPU-owned picks — safe to
// call any time during the draft (no-op if it's already a human's turn).
app.post(
  "/api/draft/advance",
  asyncRoute(async (req, res) => {
    res.json(await store.advanceDraft());
  })
);

// A human GM's pick. Validates it's actually that team's turn, then
// resumes auto-picking through any CPU picks that immediately follow.
app.post(
  "/api/draft/pick",
  requireTeam,
  asyncRoute(async (req, res) => {
    const { prospectId } = req.body;
    res.json(await store.makeDraftPick({ teamId: req.teamId, prospectId: Number(prospectId) }));
  })
);

// This round's CPU-trade proposals — scoped to ?teamId= so a GM only ever
// sees their own proposals, never a competitor's.
app.get(
  "/api/traderounds/proposals",
  requireTeam,
  asyncRoute(async (req, res) => {
    res.json(await store.getTradeProposals(req.teamId));
  })
);

// Proposes a two-sided trade with a CPU-controlled team (up to 5
// players/picks per side). Resolved automatically (most generous offer
// wins any contested asset) when the commissioner advances the phase.
app.post(
  "/api/traderounds/proposals",
  requireTeam,
  asyncRoute(async (req, res) => {
    const { targetTeamId, offeredPlayerIds, offeredPickIds, requestedPlayerIds, requestedPickIds } = req.body;
    res.json(
      await store.submitTradeProposal({
        teamId: req.teamId,
        targetTeamId: Number(targetTeamId),
        offeredPlayerIds: (offeredPlayerIds || []).map(Number),
        offeredPickIds: (offeredPickIds || []).map(Number),
        requestedPlayerIds: (requestedPlayerIds || []).map(Number),
        requestedPickIds: (requestedPickIds || []).map(Number),
      })
    );
  })
);

// Evaluates a two-team offer (up to 5 players/picks per side) without
// changing anything — trade value comparison plus each side's likelihood of
// accepting, worded rather than shown as a raw number.
app.post(
  "/api/trades/evaluate",
  requireTeam,
  asyncRoute(async (req, res) => {
    const { teamBId, teamAAssets, teamBAssets } = req.body;
    const result = await store.evaluateTradeOffer({
      teamAId: req.teamId,
      teamBId: Number(teamBId),
      teamAAssets,
      teamBAssets,
    });
    res.json(result);
  })
);

// Sends a direct trade offer to another human-controlled team — does NOT
// move anything yet. Re-validates ownership itself rather than trusting a
// prior /evaluate call. The target team's own GM has to accept it (see
// /api/trades/human-offers/:id/respond) before assets actually change hands.
app.post(
  "/api/trades/propose",
  requireTeam,
  asyncRoute(async (req, res) => {
    const { teamBId, teamAAssets, teamBAssets } = req.body;
    const result = await store.proposeTradeOffer({
      teamAId: req.teamId,
      teamBId: Number(teamBId),
      teamAAssets,
      teamBAssets,
    });
    res.json(result);
  })
);

// This team's own human-vs-human trade offers, both directions — incoming
// ones awaiting a response, and outgoing ones still awaiting someone else's.
app.get(
  "/api/trades/human-offers",
  requireTeam,
  asyncRoute(async (req, res) => {
    res.json(await store.getHumanTradeOffers(req.teamId));
  })
);

// The target team's explicit accept/decline of an incoming offer — the only
// place these assets actually move.
app.post(
  "/api/trades/human-offers/:id/respond",
  requireTeam,
  asyncRoute(async (req, res) => {
    const { accept } = req.body;
    res.json(
      await store.respondToHumanTradeOffer({
        teamId: req.teamId,
        offerId: Number(req.params.id),
        accept: Boolean(accept),
      })
    );
  })
);

// Lets the proposing team cancel its own still-pending offer.
app.post(
  "/api/trades/human-offers/:id/withdraw",
  requireTeam,
  asyncRoute(async (req, res) => {
    res.json(await store.withdrawHumanTradeOffer({ teamId: req.teamId, offerId: Number(req.params.id) }));
  })
);

// CPU-initiated trade offers addressed to this team — the reverse
// direction of /api/traderounds/proposals. Never auto-resolved; the human
// must explicitly accept or decline each one.
app.get(
  "/api/traderounds/cpu-offers",
  requireTeam,
  asyncRoute(async (req, res) => {
    res.json(await store.getCpuTradeOffers(req.teamId));
  })
);

app.post(
  "/api/traderounds/cpu-offers/:id/respond",
  requireTeam,
  asyncRoute(async (req, res) => {
    const { accept } = req.body;
    res.json(
      await store.respondToCpuTradeOffer({
        teamId: req.teamId,
        offerId: Number(req.params.id),
        accept: Boolean(accept),
      })
    );
  })
);

// MyGM — a team's own not-yet-resolved offers across free agency,
// re-signing, and trade proposals, all in one place.
app.get(
  "/api/mygm/pending-moves",
  requireTeam,
  asyncRoute(async (req, res) => {
    res.json(await store.getPendingMoves(req.teamId));
  })
);

// A feed of outcomes ("signed X", "lost bidding for Y", "trade fell
// through") — only ever written by round-resolution, not by submitting an
// offer. Unread count is tracked per-team in the DB, not per-browser.
app.get(
  "/api/mygm/notifications",
  requireTeam,
  asyncRoute(async (req, res) => {
    res.json(await store.getNotifications(req.teamId));
  })
);

app.get(
  "/api/mygm/notifications/unread-count",
  requireTeam,
  asyncRoute(async (req, res) => {
    res.json({ count: await store.getUnreadNotificationCount(req.teamId) });
  })
);

app.post(
  "/api/mygm/notifications/read",
  requireTeam,
  asyncRoute(async (req, res) => {
    res.json(await store.markNotificationsRead(req.teamId));
  })
);

// League-wide feed of every team's transactions, both completed (signed,
// re-signed, trade completed) and failed (outbid, offer rejected, trade
// fell through) — unlike /mygm/notifications, this is NOT privacy-scoped,
// it's the public transactions log under the League tab.
app.get(
  "/api/league/transactions",
  asyncRoute(async (req, res) => {
    res.json(await store.getLeagueTransactions());
  })
);

app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

async function start() {
  // Bootstraps every league's database in turn (schema migrations are
  // idempotent — see schema.sql — so this is safe to run on every restart,
  // not just the first one). Each already has data cloned from the
  // original single-league database, so `seeded` is expected to be false
  // for all three going forward; this only actually seeds a league whose
  // database starts genuinely empty (e.g. a new league added later).
  for (const slug of LEAGUE_SLUGS) {
    await runWithLeague(slug, async () => {
      const seeded = await initDatabase();
      if (seeded) {
        console.log(`[${slug}] Database was empty — seeded initial league data`);
      }
    });
  }

  // Catch-up simulation is an explicit commissioner action (POST
  // /api/sim/advance, or "Advance League Date") — it used to also run here
  // on every server boot, which silently re-simmed any due CPU games (e.g.
  // day-1 games, which are always "due" once league_date reaches the
  // season's start) every time the dev server restarted, even with no
  // commissioner action taken.
  app.listen(PORT, () => {
    console.log(`Hockey Franchise League API listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

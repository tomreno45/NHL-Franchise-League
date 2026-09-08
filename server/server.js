const path = require("path");
const express = require("express");
const cors = require("cors");
const session = require("express-session");
const pgSessionStore = require("connect-pg-simple")(session);
const ExcelJS = require("exceljs");
const store = require("./store");
const { initDatabase } = require("./seed");
const { sessionPool, runWithLeague, LEAGUE_SLUGS, LEAGUES } = require("./db");
const { SKATER_ATTRS, GOALIE_ATTRS } = require("./data");
const push = require("./push");
const accounts = require("./accounts");

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

// Attaches the league label to a membership row for client display, and
// filters out any membership pointing at a league slug that no longer
// exists in LEAGUES (shouldn't happen outside of local config changes, but
// cheap to guard rather than send the client a membership it can't render).
function describeMemberships(memberships) {
  return memberships
    .filter((m) => LEAGUE_SLUGS.includes(m.leagueSlug))
    .map((m) => ({ ...m, leagueLabel: LEAGUES[m.leagueSlug].label }));
}

// The one response shape every "fully logged in" auth response uses (the
// single-membership login path, /api/auth/select-league, and /api/auth/me)
// — always carries the full membership list too, not just the active one,
// so AccountMenu.jsx can render a league switcher without a second request.
function buildUserResponse(account, activeMembership, allMemberships) {
  return {
    ...account,
    teamId: activeMembership.teamId,
    role: activeMembership.role,
    league: { slug: activeMembership.leagueSlug, label: LEAGUES[activeMembership.leagueSlug].label },
    memberships: describeMemberships(allMemberships),
  };
}

// Shared by /api/auth/login (once mustChangePassword is cleared) and
// /api/auth/change-password (right after it's cleared) — both end up
// needing the exact same "credentials are good, now what" branching, so
// it's one place instead of two copies drifting apart.
async function finishLogin(req, account) {
  req.session.accountId = account.id;
  // Set once here, regardless of which branch below runs — it's a property
  // of the login itself, not of which league (if any) ends up active, so it
  // has to survive /api/auth/select-league and every later request the same
  // way accountId does.
  req.session.isAdmin = account.isAdmin;

  const memberships = await accounts.getMemberships(account.id);

  if (account.isAdmin) {
    // Admins always get an explicit choice, even with exactly one
    // membership or none at all — they might want the Admin Panel instead
    // of jumping straight into a league, so this never auto-finalizes the
    // way a single-membership non-admin login does.
    return { needsLeagueSelection: true, account, memberships: describeMemberships(memberships) };
  }

  if (memberships.length === 0) {
    const err = new Error("This account isn't part of any league yet — ask your commissioner to add you.");
    err.status = 403;
    throw err;
  }
  if (memberships.length > 1) {
    // Credentials are already fully verified at this point — all that's
    // pending is which of the account's leagues to open. accountId alone
    // isn't enough to pass requireAuth (which also needs leagueSlug), so
    // nothing protected is reachable until /api/auth/select-league below
    // finishes the job.
    return { needsLeagueSelection: true, account, memberships: describeMemberships(memberships) };
  }
  const [membership] = memberships;
  req.session.teamId = membership.teamId;
  req.session.leagueSlug = membership.leagueSlug;
  req.session.role = membership.role;
  return buildUserResponse(account, membership, memberships);
}

// No public signup — accounts are created invite-only via ManageUsers.jsx
// (or server/scripts/createUser.js) by a commissioner. An account can now
// belong to more than one league (see accounts.js), so login no longer
// asks which league up front — it's derived from the account's own
// memberships instead. These routes are the only ones that work without a
// session already established.
app.post(
  "/api/auth/login",
  asyncRoute(async (req, res) => {
    const { username, password } = req.body;
    const account = await accounts.verifyAccountLogin(username, password);
    if (!account) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    if (account.mustChangePassword) {
      // Someone else (an admin) picked this password — hold off on
      // memberships/isAdmin branching entirely until they've replaced it
      // with one only they know. accountId alone is enough to reach
      // /api/auth/change-password below (see requireAccount).
      req.session.accountId = account.id;
      req.session.isAdmin = account.isAdmin;
      return res.json({ needsPasswordChange: true, account });
    }

    res.json(await finishLogin(req, account));
  })
);

// Finishes a login that was interrupted by mustChangePassword — the account
// holder sets their own new password (no old-password check: reaching this
// route already proved they hold the current one, temporary or not), then
// falls through to the exact same branching a normal login would have done.
app.post(
  "/api/auth/change-password",
  requireAccount,
  asyncRoute(async (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword) return res.status(400).json({ error: "newPassword is required" });
    const account = await accounts.changePassword(req.session.accountId, newPassword);
    res.json(await finishLogin(req, account));
  })
);

// Finishes a login that had more than one membership to choose from, or
// switches an already-fully-logged-in session to a different one of the
// account's leagues — same endpoint either way, since both are just "pick
// which membership is active now."
app.post(
  "/api/auth/select-league",
  requireAccount,
  asyncRoute(async (req, res) => {
    const { leagueSlug } = req.body;
    const membership = await accounts.getMembership(req.session.accountId, leagueSlug);
    if (!membership) {
      return res.status(403).json({ error: "This account isn't a member of that league" });
    }
    const account = await accounts.getAccountById(req.session.accountId);
    const memberships = await accounts.getMemberships(req.session.accountId);
    req.session.teamId = membership.teamId;
    req.session.leagueSlug = membership.leagueSlug;
    req.session.role = membership.role;
    res.json(buildUserResponse(account, membership, memberships));
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
    if (!req.session.accountId) {
      return res.status(401).json({ error: "Not logged in" });
    }
    const account = await accounts.getAccountById(req.session.accountId);
    if (!account) {
      // The account was deleted out from under an existing session.
      return req.session.destroy(() => res.status(401).json({ error: "Not logged in" }));
    }
    if (account.mustChangePassword) {
      return res.json({ needsPasswordChange: true, account });
    }
    const memberships = await accounts.getMemberships(account.id);
    if (!req.session.leagueSlug) {
      // Mid-selection (e.g. the tab was closed/refreshed right after a
      // multi-league login, before a league was picked) — credentials are
      // still valid, so this isn't a 401, just the same "pick one" prompt
      // login itself would have returned.
      return res.json({ needsLeagueSelection: true, account, memberships: describeMemberships(memberships) });
    }
    const membership = memberships.find((m) => m.leagueSlug === req.session.leagueSlug);
    if (!membership) {
      // The membership this session was pinned to got removed elsewhere
      // (a commissioner action) since this session last checked in.
      return req.session.destroy(() => res.status(401).json({ error: "Not logged in" }));
    }
    res.json(buildUserResponse(account, membership, memberships));
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

// Guards /api/auth/select-league only — credentials are already fully
// verified once accountId is set (see /api/auth/login), all that's
// pending is which league to open, so this is deliberately lighter than
// requireAuth below (no leagueSlug requirement).
function requireAccount(req, res, next) {
  if (!req.session.accountId) {
    return res.status(401).json({ error: "Not logged in" });
  }
  next();
}

// Guards every /api/admin/* route. Deliberately does NOT require
// leagueSlug (unlike requireAuth below) — admin actions span every league,
// so an admin who logged in and went straight to the Admin Panel without
// ever picking one still needs full access. isAdmin is set once at login
// (see /api/auth/login) and carries forward through league switches the
// same way accountId does.
function requireAdmin(req, res, next) {
  if (!req.session.accountId || !req.session.isAdmin) {
    return res.status(403).json({ error: "Admin only" });
  }
  next();
}

// The in-app equivalent of the developer CLIs (createUser.js,
// resetPassword.js, deleteAccount.js, migrateToGlobalAccounts.js) — every
// account in every league, not scoped to the caller's own league the way
// ManageUsers.jsx/the /api/commissioner/* routes are. Registered before
// requireAuth below since these don't need (and admins may not have) an
// active leagueSlug.

app.get(
  "/api/admin/accounts",
  requireAdmin,
  asyncRoute(async (req, res) => {
    res.json(await accounts.getAllAccountsWithMemberships());
  })
);

app.post(
  "/api/admin/accounts",
  requireAdmin,
  asyncRoute(async (req, res) => {
    const { username, password, displayName } = req.body;
    const account = await accounts.createAccount({ username, password, displayName });
    res.status(201).json(account);
  })
);

app.post(
  "/api/admin/accounts/:id/reset-password",
  requireAdmin,
  asyncRoute(async (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword) return res.status(400).json({ error: "newPassword is required" });
    const account = await accounts.resetPassword(Number(req.params.id), newPassword);
    res.json(account);
  })
);

// Full, irreversible delete — every membership and push subscription goes
// with it (ON DELETE CASCADE). Mirrors the is_human_controlled cleanup
// scripts/deleteAccount.js does (a bug was caught there during testing:
// this flip is easy to forget and leaves a team stuck human-controlled
// with nobody actually assigned).
app.delete(
  "/api/admin/accounts/:id",
  requireAdmin,
  asyncRoute(async (req, res) => {
    const accountId = Number(req.params.id);
    const memberships = await accounts.getMemberships(accountId);
    const account = await accounts.deleteAccountEntirely(accountId);
    for (const m of memberships) {
      if (m.teamId == null) continue;
      const remaining = await accounts.countMembersOnTeam(m.leagueSlug, m.teamId);
      if (remaining === 0) {
        await runWithLeague(m.leagueSlug, () => store.setTeamHumanControlled(m.teamId, false));
      }
    }
    res.json({ deleted: true, account });
  })
);

// Teams for an arbitrary league, for the Admin Panel's add-membership team
// picker — /api/teams (below) is scoped to the caller's own active league,
// which an admin may not have set.
app.get(
  "/api/admin/teams/:leagueSlug",
  requireAdmin,
  asyncRoute(async (req, res) => {
    const { leagueSlug } = req.params;
    if (!LEAGUE_SLUGS.includes(leagueSlug)) return res.status(400).json({ error: "Unknown league" });
    res.json(await runWithLeague(leagueSlug, () => store.getTeams()));
  })
);

app.post(
  "/api/admin/accounts/:id/memberships",
  requireAdmin,
  asyncRoute(async (req, res) => {
    const accountId = Number(req.params.id);
    const { leagueSlug, teamId, role } = req.body;
    if (!LEAGUE_SLUGS.includes(leagueSlug)) return res.status(400).json({ error: "Unknown league" });
    const resolvedTeamId = teamId ? Number(teamId) : null;
    if (resolvedTeamId != null) {
      const teams = await runWithLeague(leagueSlug, () => store.getTeams());
      if (!teams.some((t) => t.id === resolvedTeamId)) {
        return res.status(400).json({ error: "Unknown team" });
      }
    }
    const membership = await accounts.addMembership({ accountId, leagueSlug, teamId: resolvedTeamId, role });
    if (resolvedTeamId != null) {
      await runWithLeague(leagueSlug, () => store.setTeamHumanControlled(resolvedTeamId, true));
    }
    res.status(201).json(membership);
  })
);

app.delete(
  "/api/admin/memberships/:membershipId",
  requireAdmin,
  asyncRoute(async (req, res) => {
    const result = await accounts.removeMembershipByIdAsAdmin(Number(req.params.membershipId));
    if (result.teamId != null) {
      const remaining = await accounts.countMembersOnTeam(result.leagueSlug, result.teamId);
      if (remaining === 0) {
        await runWithLeague(result.leagueSlug, () => store.setTeamHumanControlled(result.teamId, false));
      }
    }
    res.json(result);
  })
);

// Everything below this line requires a logged-in session with a league
// actively selected — a multi-league account that's logged in but hasn't
// finished picking a league yet (accountId set, leagueSlug not) still 401s
// here, same as a fully logged-out request; the client is expected to
// resolve that via /api/auth/me's needsLeagueSelection response instead of
// ever hitting one of these routes in that state.
function requireAuth(req, res, next) {
  if (!req.session.accountId || !req.session.leagueSlug) {
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

// Web Push (browser notifications) — subscribe/unsubscribe are per-login,
// not per-team, since a commissioner-only account (no team) can still want
// them. No requireTeam here for that reason.
app.get(
  "/api/push/public-key",
  asyncRoute(async (req, res) => {
    res.json({ configured: push.configured, publicKey: push.configured ? push.publicKey : null });
  })
);

app.post(
  "/api/push/subscribe",
  asyncRoute(async (req, res) => {
    await push.saveSubscription(req.session.accountId, req.body);
    res.json({ subscribed: true });
  })
);

app.post(
  "/api/push/unsubscribe",
  asyncRoute(async (req, res) => {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: "endpoint is required" });
    await push.removeSubscription(endpoint);
    res.json({ subscribed: false });
  })
);

// The commissioner's own free-text broadcast — everything else that pushes
// (phase advances, human trade offers) is triggered automatically from
// store.js; this is the one manually-triggered send, so it lives here
// rather than behind a store.js function of its own.
app.post(
  "/api/commissioner/push",
  requireCommissioner,
  asyncRoute(async (req, res) => {
    const { title, message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: "message is required" });
    if (!push.configured) return res.status(400).json({ error: "Push notifications aren't configured on this server" });
    await push.sendToAllUsers({ title: title?.trim() || "Hockey Franchise League", body: message.trim() });
    res.json({ sent: true });
  })
);

app.get(
  "/api/standings",
  asyncRoute(async (req, res) => {
    res.json(await store.getStandings());
  })
);

app.get(
  "/api/teams",
  asyncRoute(async (req, res) => {
    const [teams, members] = await Promise.all([store.getTeams(), accounts.getMembersOfLeague(req.session.leagueSlug)]);
    // Nothing stops two accounts sharing a team_id (no such uniqueness
    // constraint — see accounts.js) so this joins every GM assigned to a
    // team, not just the first, rather than silently dropping a co-GM.
    const gmNamesByTeam = new Map();
    for (const m of members) {
      if (m.teamId == null) continue;
      const names = gmNamesByTeam.get(m.teamId) || [];
      names.push(m.displayName);
      gmNamesByTeam.set(m.teamId, names);
    }
    res.json(teams.map((t) => ({ ...t, gmDisplayName: gmNamesByTeam.get(t.id)?.join(" & ") ?? null })));
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
    res.json(await accounts.getMembersOfLeague(req.session.leagueSlug));
  })
);

// Lets the commissioner's "add account" form check, before submitting,
// whether a username already has an account somewhere (any league) — if
// so the form just needs a team/role to add them to this league, not a
// whole new password. Commissioner-only since finding out a username
// exists (and its display name) is a small cross-league disclosure that
// didn't exist when every league's accounts were fully isolated.
app.get(
  "/api/commissioner/accounts/:username",
  requireCommissioner,
  asyncRoute(async (req, res) => {
    const account = await accounts.findAccountByUsername(req.params.username);
    if (!account) return res.status(404).json({ error: "No account with that username" });
    res.json(account);
  })
);

// Adds someone to this league — either a brand-new account (username +
// password + displayName, all required) or an existing account found via
// the lookup above (pass its accountId instead, no password needed). team
// assignment flips that team human-controlled the moment someone's
// assigned to it, same as before; teamId is validated against this
// league's own teams here since account_memberships.team_id can't be a
// real foreign key (teams live in a separate physical database per
// league).
app.post(
  "/api/commissioner/users",
  requireCommissioner,
  asyncRoute(async (req, res) => {
    const { accountId, username, password, displayName, teamId, role } = req.body;
    const resolvedTeamId = teamId ? Number(teamId) : null;
    if (resolvedTeamId != null) {
      const teams = await store.getTeams();
      if (!teams.some((t) => t.id === resolvedTeamId)) {
        return res.status(400).json({ error: "Unknown team" });
      }
    }
    const account = accountId
      ? await accounts.getAccountById(Number(accountId))
      : await accounts.createAccount({ username, password, displayName });
    if (!account) return res.status(404).json({ error: "Account not found" });
    const membership = await accounts.addMembership({
      accountId: account.id,
      leagueSlug: req.session.leagueSlug,
      teamId: resolvedTeamId,
      role,
    });
    if (resolvedTeamId != null) {
      await store.setTeamHumanControlled(resolvedTeamId, true);
    }
    res.status(201).json({ ...account, teamId: membership.teamId, role: membership.role });
  })
);

// Removes someone from THIS league only — their account (and any other
// league's membership) is untouched. accounts.removeMembership refuses to
// remove the caller's own membership (would lock the commissioner out
// mid-session) or the last remaining commissioner in this league.
app.delete(
  "/api/commissioner/users/:id",
  requireCommissioner,
  asyncRoute(async (req, res) => {
    const result = await accounts.removeMembership({
      membershipId: Number(req.params.id),
      expectedLeagueSlug: req.session.leagueSlug,
      requestingAccountId: req.session.accountId,
    });
    if (result.teamId != null) {
      const remaining = await accounts.countMembersOnTeam(req.session.leagueSlug, result.teamId);
      if (remaining === 0) {
        await store.setTeamHumanControlled(result.teamId, false);
      }
    }
    res.json(result);
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

// Signs one of the team's own unsigned draft picks to the standard
// entry-level deal — no offer/resolve cycle, since only the drafting team
// can act on it (see store.js's signDraftRights). Available any time, not
// gated to the resigning phase.
app.post(
  "/api/resigning/sign-draft-rights",
  requireTeam,
  asyncRoute(async (req, res) => {
    const { playerId } = req.body;
    res.json(await store.signDraftRights({ teamId: req.teamId, playerId: Number(playerId) }));
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

// "camelCase" -> "Camel Case", for turning attribute keys into readable
// column headers without hand-maintaining a separate label map.
function attrColumnLabel(attr) {
  return attr.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

// Backs both /api/progression/export/* routes below — same workbook shape
// (a Skaters sheet and a Goalies sheet, since the two positions don't share
// an attribute set) for either the "needs update" or "not created" rows.
async function buildRosterSyncWorkbook(status) {
  const rows = await store.getRosterSyncExport(status);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Hockey Franchise League";
  workbook.created = new Date();

  const baseColumns = [
    { header: "Team", key: "team", width: 24 },
    { header: "Name", key: "name", width: 22 },
    { header: "Pos", key: "position", width: 6 },
    { header: "Jersey #", key: "jersey", width: 10 },
    { header: "Age", key: "age", width: 6 },
    { header: "Overall", key: "overall", width: 8 },
  ];

  const addSheet = (sheetName, positionFilter, attrs) => {
    const sheet = workbook.addWorksheet(sheetName);
    sheet.columns = [...baseColumns, ...attrs.map((attr) => ({ header: attrColumnLabel(attr), key: attr, width: 10 }))];
    sheet.getRow(1).font = { bold: true };
    sheet.autoFilter = { from: "A1", to: { row: 1, column: sheet.columns.length } };
    rows
      .filter((p) => positionFilter(p.position))
      .forEach((p) => {
        sheet.addRow({
          team: `${p.team.city} ${p.team.name}`,
          name: p.name,
          position: p.position,
          jersey: p.jerseyNumber,
          age: p.age,
          overall: p.overall,
          ...p.attributes,
        });
      });
    return sheet;
  };

  addSheet("Skaters", (pos) => pos !== "G", SKATER_ATTRS);
  addSheet("Goalies", (pos) => pos === "G", GOALIE_ATTRS);

  return workbook;
}

async function sendRosterSyncWorkbook(res, status, filename) {
  const workbook = await buildRosterSyncWorkbook(status);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
}

// Every human team's players whose ratings changed enough (trade, signing,
// progression, re-signing) that the existing NHL 27 player needs editing.
app.get(
  "/api/progression/export/needs-update",
  asyncRoute(async (req, res) => {
    await sendRosterSyncWorkbook(res, "needs_update", "players-needing-updates.xlsx");
  })
);

// Every human team's players who don't exist in NHL 27 yet (drafted
// rookies, most commonly) and need to be created from scratch.
app.get(
  "/api/progression/export/not-created",
  asyncRoute(async (req, res) => {
    await sendRosterSyncWorkbook(res, "not_created", "players-needing-creation.xlsx");
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
  // Global login identity (accounts/account_memberships/push_subscriptions)
  // lives in sessionPool's database, not one of the per-league ones below —
  // bootstrapped once, not per-league.
  await accounts.ensureGlobalSchema();

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

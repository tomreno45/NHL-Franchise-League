import { useMemo, useState } from "react";
import { AuthProvider, useAuth } from "./AuthContext";
import { MyTeamProvider } from "./MyTeamContext";
import { LeaguePhaseProvider, useLeaguePhase } from "./LeaguePhaseContext";
import { NotificationsProvider, useNotifications } from "./NotificationsContext";
import { PHASE_LABELS } from "./phaseLabels";
import Login from "./components/Login";
import AccountMenu from "./components/AccountMenu";
import PhaseBanner from "./components/PhaseBanner";
import PhaseLock from "./components/PhaseLock";
import NotificationBadge from "./components/NotificationBadge";
import Standings from "./components/Standings";
import TeamRoster from "./components/TeamRoster";
import LeagueRosters from "./components/LeagueRosters";
import Schedule from "./components/Schedule";
import ScoringLeaders from "./components/ScoringLeaders";
import Progression from "./components/Progression";
import DraftPicks from "./components/DraftPicks";
import DraftBoard from "./components/DraftBoard";
import TradeCenter from "./components/TradeCenter";
import FreeAgency from "./components/FreeAgency";
import SetRoster from "./components/SetRoster";
import RosterMoves from "./components/RosterMoves";
import Resigning from "./components/Resigning";
import Commissioner from "./components/Commissioner";
import UserList from "./components/UserList";
import PendingMoves from "./components/PendingMoves";
import Notifications from "./components/Notifications";
import LeagueTransactions from "./components/LeagueTransactions";

// Phases each tab requires to be open. Omitted from this map = always
// available (read-only views, or tabs like Commissioner/Trade Center that
// are already phase-conditional internally). Progression used to be locked
// to the `progression` phase, but its two roster-sync spreadsheet downloads
// need to work all season (trades and signings flag players needs-update
// year-round, not just during the Progression phase), so the tab is always
// open now — the "Run Offseason Progression" button inside it already warns
// against running it off-cycle on its own.
const TAB_PHASES = {};

const GROUPS = [
  {
    key: "myteam",
    label: "My Team",
    tabs: [
      { key: "roster", label: "Roster", Component: TeamRoster },
      { key: "setroster", label: "Set Lineup", Component: SetRoster },
      { key: "rostermoves", label: "Roster Moves", Component: RosterMoves },
      { key: "resigning", label: "Re-Signing", Component: Resigning },
    ],
  },
  {
    key: "transactions",
    label: "Transactions",
    tabs: [
      { key: "draft", label: "Draft Picks", Component: DraftPicks },
      { key: "prospects", label: "Draft Board", Component: DraftBoard },
      { key: "freeagency", label: "Free Agency", Component: FreeAgency },
      { key: "trades", label: "Trade Center", Component: TradeCenter },
    ],
  },
  {
    key: "league",
    label: "League",
    tabs: [
      { key: "standings", label: "Standings", Component: Standings },
      { key: "rosters", label: "Rosters", Component: LeagueRosters },
      { key: "schedule", label: "Schedule", Component: Schedule },
      { key: "scorers", label: "Stats", Component: ScoringLeaders },
      { key: "progression", label: "Progression", Component: Progression },
      { key: "leaguetransactions", label: "Transactions", Component: LeagueTransactions },
    ],
  },
  {
    key: "mygm",
    label: "MyGM",
    tabs: [
      { key: "pendingmoves", label: "Pending Moves", Component: PendingMoves },
      { key: "notifications", label: "Notifications", Component: Notifications },
      { key: "userlist", label: "User List", Component: UserList },
      { key: "commissioner", label: "Commissioner", Component: Commissioner },
    ],
  },
];

function AppShell() {
  const [activeGroupKey, setActiveGroupKey] = useState("league");
  const [activeTabKey, setActiveTabKey] = useState("standings");
  const { user } = useAuth();
  const { phase } = useLeaguePhase();
  const { unreadCount } = useNotifications();

  // The Commissioner tab performs league-wide actions (advance date, crown
  // champion, override draft order, regenerate draft class) the backend
  // already restricts to the commissioner role (see server.js's
  // requireCommissioner) — dropped from the nav entirely for anyone else
  // rather than shown and just erroring on every click.
  const groups = useMemo(
    () =>
      GROUPS.map((g) =>
        g.key === "mygm" && user.role !== "commissioner"
          ? { ...g, tabs: g.tabs.filter((t) => t.key !== "commissioner") }
          : g
      ),
    [user.role]
  );

  const activeGroup = groups.find((g) => g.key === activeGroupKey);
  const activeTab = activeGroup.tabs.find((t) => t.key === activeTabKey) ?? activeGroup.tabs[0];
  const Active = activeTab.Component;

  const handleGroupClick = (group) => {
    setActiveGroupKey(group.key);
    setActiveTabKey(group.tabs[0].key);
  };

  const allowedPhases = TAB_PHASES[activeTab.key];
  const locked = Boolean(allowedPhases && phase && !allowedPhases.includes(phase.phase));

  const isTabLocked = (tabKey) => {
    const allowed = TAB_PHASES[tabKey];
    return Boolean(allowed && phase && !allowed.includes(phase.phase));
  };

  return (
    <div className="min-h-screen text-slate-200">
      <header className="flex items-center justify-between gap-3 border-b border-white/5 px-4 py-3 sm:px-6 sm:py-4">
        <div className="min-w-0">
          <h1 className="truncate text-base font-bold tracking-tight text-slate-100 sm:text-xl">
            Hockey Franchise League
          </h1>
          <p className="hub-label hidden sm:block">Season Dashboard</p>
        </div>
        <AccountMenu />
      </header>

      <PhaseBanner />

      {/* Section switcher — a horizontally scrolling strip on narrow
          screens instead of wrapping to a second line, which used to push
          everything below it down and out of view on a phone. */}
      <nav className="flex gap-1 overflow-x-auto border-b border-white/5 bg-black/10 px-4 sm:px-6">
        {groups.map((g) => (
          <button
            key={g.key}
            type="button"
            onClick={() => handleGroupClick(g)}
            className={`flex shrink-0 items-center whitespace-nowrap px-3 py-2.5 text-sm font-semibold uppercase tracking-wide transition-colors sm:px-4 ${
              activeGroupKey === g.key
                ? "border-b-2 border-cyan-400 text-cyan-300"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {g.label}
            {g.key === "mygm" && <NotificationBadge count={unreadCount} />}
          </button>
        ))}
      </nav>

      {/* Below sm, the persistent left sidebar collapses into its own
          horizontally scrolling pill strip (same pattern as the group
          switcher above) rather than permanently eating ~150px off a
          375px-wide screen. */}
      <nav className="flex gap-1 overflow-x-auto border-b border-white/5 px-4 py-2 sm:hidden">
        {activeGroup.tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActiveTabKey(t.key)}
            className={`flex shrink-0 items-center whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              activeTabKey === t.key
                ? "bg-cyan-400/10 text-slate-100"
                : isTabLocked(t.key)
                  ? "text-slate-600"
                  : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
            }`}
          >
            {t.label}
            {t.key === "notifications" && <NotificationBadge count={unreadCount} />}
          </button>
        ))}
      </nav>

      <div className="flex">
        <aside className="hidden w-56 shrink-0 border-r border-white/5 px-3 py-6 sm:block">
          <p className="hub-label mb-3 px-3">{activeGroup.label}</p>
          <nav className="flex flex-col gap-0.5">
            {activeGroup.tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setActiveTabKey(t.key)}
                className={`flex items-center rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  activeTabKey === t.key
                    ? "bg-cyan-400/10 font-semibold text-slate-100"
                    : isTabLocked(t.key)
                      ? "text-slate-600 hover:text-slate-400"
                      : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                }`}
              >
                {t.label}
                {t.key === "notifications" && <NotificationBadge count={unreadCount} />}
              </button>
            ))}
          </nav>
        </aside>

        <main className="min-w-0 flex-1 p-3 sm:p-6">
          {locked ? (
            <PhaseLock
              currentLabel={PHASE_LABELS[phase.phase] || phase.phase}
              availableLabel={allowedPhases.map((p) => PHASE_LABELS[p] || p).join(" or ")}
            />
          ) : (
            <Active />
          )}
        </main>
      </div>
    </div>
  );
}

function AuthGate() {
  const { user } = useAuth();

  if (user === undefined) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950">
        <p className="text-slate-500">Loading…</p>
      </div>
    );
  }

  if (user === null) {
    return <Login />;
  }

  return (
    <MyTeamProvider>
      <LeaguePhaseProvider>
        <NotificationsProvider>
          <AppShell />
        </NotificationsProvider>
      </LeaguePhaseProvider>
    </MyTeamProvider>
  );
}

function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}

export default App;

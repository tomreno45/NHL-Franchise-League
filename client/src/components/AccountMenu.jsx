import { useState } from "react";
import { useMyTeam } from "../MyTeamContext";
import { useAuth } from "../AuthContext";
import TeamLogo from "./TeamLogo";

// A plain badge for the common case (one league); a small switcher instead
// once an account has more than one membership — switching calls
// AuthContext's selectLeague, which re-keys the provider tree in App.jsx so
// the whole app cleanly refetches for the newly active league.
function LeagueBadge({ user, selectLeague }) {
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState(null);

  if (!user.league) return null;
  if (!user.memberships || user.memberships.length <= 1) {
    return (
      <span className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-cyan-300">
        {user.league.label}
      </span>
    );
  }

  const handleChange = async (e) => {
    const leagueSlug = e.target.value;
    if (leagueSlug === user.league.slug) return;
    setSwitching(true);
    setError(null);
    try {
      await selectLeague(leagueSlug);
    } catch (err) {
      setError(err.message);
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className="flex flex-col items-end">
      <select
        value={user.league.slug}
        onChange={handleChange}
        disabled={switching}
        title="Switch league"
        className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-cyan-300 disabled:opacity-50"
      >
        {user.memberships.map((m) => (
          <option key={m.leagueSlug} value={m.leagueSlug} className="bg-slate-900 text-slate-100">
            {m.leagueLabel}
          </option>
        ))}
      </select>
      {error && <span className="mt-1 text-[11px] text-red-400">{error}</span>}
    </div>
  );
}

export default function AccountMenu() {
  const { user, logout, selectLeague } = useAuth();
  const { teams } = useMyTeam();

  const myTeam = teams.find((t) => t.id === user?.teamId);

  return (
    <div className="flex items-center gap-3">
      <LeagueBadge user={user} selectLeague={selectLeague} />
      <div className="text-right">
        <p className="text-sm font-medium text-slate-100">{user.displayName}</p>
        <p className="text-xs text-slate-500">{myTeam ? `${myTeam.city} ${myTeam.name}` : "No team assigned"}</p>
      </div>
      {myTeam && <TeamLogo abbr={myTeam.abbr} size={36} />}
      <button
        type="button"
        onClick={logout}
        className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-400 hover:border-slate-600 hover:text-slate-200"
      >
        Log Out
      </button>
    </div>
  );
}

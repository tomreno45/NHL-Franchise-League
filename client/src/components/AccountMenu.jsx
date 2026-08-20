import { useMyTeam } from "../MyTeamContext";
import { useAuth } from "../AuthContext";
import TeamLogo from "./TeamLogo";

export default function AccountMenu() {
  const { user, logout } = useAuth();
  const { teams } = useMyTeam();

  const myTeam = teams.find((t) => t.id === user?.teamId);

  return (
    <div className="flex items-center gap-3">
      {user.league && (
        <span className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-cyan-300">
          {user.league.label}
        </span>
      )}
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

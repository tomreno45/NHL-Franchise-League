import { useEffect, useState } from "react";
import { api } from "../api";
import { useMyTeam } from "../MyTeamContext";
import { PHASE_LABELS } from "../phaseLabels";

const ROLE_LABELS = { user: "User", commissioner: "Commissioner" };

export default function UserList() {
  const { teams } = useMyTeam();
  const [users, setUsers] = useState(null);
  const [readyStatus, setReadyStatus] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getUsers().then(setUsers).catch((e) => setError(e.message));
    // Best-effort — a stale/missing ready status just means the column
    // shows "—" for everyone rather than blocking the whole list.
    api.getReadyStatus().then(setReadyStatus).catch(() => {});
  }, []);

  const teamLabel = (teamId) => {
    if (teamId == null) return "No team";
    const t = teams.find((t) => t.id === teamId);
    return t ? `${t.city} ${t.name}` : `Team #${teamId}`;
  };

  // getReadyStatus's teams list is only the human-controlled ones (there's
  // no "ready" concept for a team with nobody assigned), so a commissioner-
  // only account (no team) or a team that isn't in this round's checkpoint
  // yet both fall through to null, not false.
  const readyForTeam = (teamId) => {
    if (teamId == null || !readyStatus) return null;
    const entry = readyStatus.teams.find((t) => t.teamId === teamId);
    return entry ? entry.ready : null;
  };

  if (error) return <p className="text-red-500">{error}</p>;
  if (!users) return <p className="text-slate-400">Loading users…</p>;

  return (
    <div>
      <h2 className="mb-1 text-lg font-semibold text-slate-100">User List</h2>
      <p className="mb-4 text-sm text-slate-500">
        Every login account in this league.
        {readyStatus &&
          ` Ready column reflects ${PHASE_LABELS[readyStatus.phase] || readyStatus.phase}, Round ${readyStatus.phaseRound}.`}
      </p>

      <div className="overflow-x-auto rounded-lg">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-800 text-left text-slate-400">
              <th className="px-3 py-2 font-medium">Username</th>
              <th className="px-3 py-2 font-medium">Display Name</th>
              <th className="px-3 py-2 font-medium">Team</th>
              <th className="px-3 py-2 font-medium">Role</th>
              <th className="px-3 py-2 font-medium">Ready</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u, i) => {
              const ready = readyForTeam(u.teamId);
              return (
                <tr key={u.id} className={i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/50"}>
                  <td className="px-3 py-2 text-slate-100">{u.username}</td>
                  <td className="px-3 py-2 text-slate-300">{u.displayName}</td>
                  <td className="px-3 py-2 text-slate-300">{teamLabel(u.teamId)}</td>
                  <td className="px-3 py-2 text-slate-300">
                    {u.role === "commissioner" ? (
                      <span className="rounded-full bg-cyan-400/10 px-2 py-0.5 text-xs font-medium text-cyan-300">
                        Commissioner
                      </span>
                    ) : (
                      ROLE_LABELS[u.role] || u.role
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {ready === null ? (
                      <span className="text-slate-600">—</span>
                    ) : ready ? (
                      <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-400">
                        Ready ✓
                      </span>
                    ) : (
                      <span className="rounded-full bg-slate-700 px-2 py-0.5 text-xs font-medium text-slate-300">
                        Not ready
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

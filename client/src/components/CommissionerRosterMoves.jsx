import { useEffect, useState } from "react";
import { api } from "../api";

function teamLabel(team) {
  return team ? `${team.city} ${team.name}` : "Free Agency";
}

function TeamPill({ team }) {
  return (
    <span className="inline-flex rounded-full bg-slate-800 px-2 py-0.5 text-xs font-medium text-slate-300">
      {team ? team.abbr : "FA"}
    </span>
  );
}

function MoveTable({ rows, columnLabel, teamKey }) {
  return (
    <div className="overflow-x-auto rounded-lg">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-slate-800 text-left text-slate-400">
            <th className="px-3 py-2 font-medium">Name</th>
            <th className="px-3 py-2 font-medium">Pos</th>
            <th className="px-3 py-2 text-right font-medium">OVR</th>
            <th className="px-3 py-2 font-medium">{columnLabel}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => (
            <tr key={p.id} className={i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/50"}>
              <td className="px-3 py-2 text-slate-100">{p.name}</td>
              <td className="px-3 py-2 text-slate-300">{p.position}</td>
              <td className="px-3 py-2 text-right text-slate-300">{p.overall}</td>
              <td className="px-3 py-2">
                <TeamPill team={p[teamKey]} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function CommissionerRosterMoves() {
  const [moves, setMoves] = useState(null);
  const [error, setError] = useState(null);
  const [clearingTeamId, setClearingTeamId] = useState(null);

  const reload = () => {
    api.getRosterMoveSync().then(setMoves).catch((e) => setError(e.message));
  };

  useEffect(reload, []);

  const handleClearTeam = async (teamId) => {
    setClearingTeamId(teamId);
    setError(null);
    try {
      const updated = await api.clearRosterMoveSync(teamId);
      setMoves(updated);
    } catch (e) {
      setError(e.message);
    } finally {
      setClearingTeamId(null);
    }
  };

  if (error) return <p className="text-red-500">{error}</p>;
  if (!moves) return <p className="text-slate-400">Loading roster moves…</p>;

  const totalPending = moves.reduce((sum, m) => sum + m.moveOnto.length + m.moveOff.length, 0);

  return (
    <div>
      <p className="mb-4 text-sm text-slate-500">
        Players who've changed teams (trades, signings, releases) but haven't been added to or removed from their
        NHL 27 roster yet. Once you've made a team's moves in-game, mark it done below.
      </p>

      {totalPending === 0 ? (
        <p className="text-sm text-slate-500">No outstanding roster moves — every human team is caught up.</p>
      ) : (
        <div className="flex flex-col gap-6">
          {moves
            .filter((m) => m.moveOnto.length > 0 || m.moveOff.length > 0)
            .map((m) => (
              <div key={m.team.id} className="rounded-lg bg-slate-900 p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h3 className="font-semibold text-slate-100">{teamLabel(m.team)}</h3>
                  <button
                    type="button"
                    onClick={() => handleClearTeam(m.team.id)}
                    disabled={clearingTeamId === m.team.id}
                    className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                  >
                    {clearingTeamId === m.team.id ? "Marking…" : "Mark Team Done"}
                  </button>
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  <div>
                    <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Move Onto Team {m.moveOnto.length > 0 && <span className="text-slate-600">({m.moveOnto.length})</span>}
                    </h4>
                    {m.moveOnto.length === 0 ? (
                      <p className="text-sm text-slate-600">Nobody to add.</p>
                    ) : (
                      <MoveTable rows={m.moveOnto} columnLabel="Old Team" teamKey="oldTeam" />
                    )}
                  </div>

                  <div>
                    <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Move Off Team {m.moveOff.length > 0 && <span className="text-slate-600">({m.moveOff.length})</span>}
                    </h4>
                    {m.moveOff.length === 0 ? (
                      <p className="text-sm text-slate-600">Nobody to remove.</p>
                    ) : (
                      <MoveTable rows={m.moveOff} columnLabel="New Team" teamKey="newTeam" />
                    )}
                  </div>
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

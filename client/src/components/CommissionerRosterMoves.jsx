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

// A player buried in the minors (or scratched) isn't going to show up on a
// real broadcast roster either way — worth knowing before bothering to
// apply a move in NHL 27 at all.
const ROSTER_STATUS = {
  MINORS: { label: "Minors", className: "bg-slate-700 text-slate-300" },
  SCRATCH: { label: "Scratched", className: "bg-amber-500/15 text-amber-400" },
};

function RosterStatusPill({ lineupSlot }) {
  const status = ROSTER_STATUS[lineupSlot] ?? { label: "Active", className: "bg-emerald-500/15 text-emerald-400" };
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${status.className}`}>{status.label}</span>;
}

function allPlayerIds(moves) {
  const ids = new Set();
  moves.forEach((m) => {
    m.moveOnto.forEach((p) => ids.add(p.id));
    m.moveOff.forEach((p) => ids.add(p.id));
  });
  return ids;
}

function MoveTable({ rows, columnLabel, teamKey, selected, onToggle }) {
  return (
    <div className="overflow-x-auto rounded-lg">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-slate-800 text-left text-slate-400">
            <th className="w-8 px-3 py-2"></th>
            <th className="px-3 py-2 font-medium">Name</th>
            <th className="px-3 py-2 font-medium">Pos</th>
            <th className="px-3 py-2 text-right font-medium">OVR</th>
            <th className="px-3 py-2 font-medium">Roster</th>
            <th className="px-3 py-2 font-medium">{columnLabel}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => (
            <tr key={p.id} className={i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/50"}>
              <td className="px-3 py-2">
                <input
                  type="checkbox"
                  checked={selected.has(p.id)}
                  onChange={() => onToggle(p.id)}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-800 accent-emerald-500"
                />
              </td>
              <td className="px-3 py-2 text-slate-100">{p.name}</td>
              <td className="px-3 py-2 text-slate-300">{p.position}</td>
              <td className="px-3 py-2 text-right text-slate-300">{p.overall}</td>
              <td className="px-3 py-2">
                <RosterStatusPill lineupSlot={p.lineupSlot} />
              </td>
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
  const [selected, setSelected] = useState(new Set());
  const [error, setError] = useState(null);
  const [clearingTeamId, setClearingTeamId] = useState(null);

  const reload = () => {
    api
      .getRosterMoveSync()
      .then((data) => {
        setMoves(data);
        // Every currently-pending player starts checked — uncheck the ones
        // not worth actually applying (e.g. someone about to move again
        // before it'd matter). Nothing persists across a reload: skip one
        // this round and it just comes back checked next time.
        setSelected(allPlayerIds(data));
      })
      .catch((e) => setError(e.message));
  };

  useEffect(reload, []);

  const toggle = (playerId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(playerId)) next.delete(playerId);
      else next.add(playerId);
      return next;
    });
  };

  const handleClearTeam = async (team) => {
    const idsForTeam = [...team.moveOnto, ...team.moveOff].map((p) => p.id).filter((id) => selected.has(id));
    if (idsForTeam.length === 0) return;
    setClearingTeamId(team.team.id);
    setError(null);
    try {
      const updated = await api.clearRosterMoveSync(idsForTeam);
      setMoves(updated);
      setSelected(allPlayerIds(updated));
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
        NHL 27 roster yet. Every player starts checked — uncheck anyone not worth actually moving (about to be
        traded again, etc.), then mark the rest done.
      </p>

      {totalPending === 0 ? (
        <p className="text-sm text-slate-500">No outstanding roster moves — every human team is caught up.</p>
      ) : (
        <div className="flex flex-col gap-6">
          {moves
            .filter((m) => m.moveOnto.length > 0 || m.moveOff.length > 0)
            .map((m) => {
              const selectedCount = [...m.moveOnto, ...m.moveOff].filter((p) => selected.has(p.id)).length;
              return (
                <div key={m.team.id} className="rounded-lg bg-slate-900 p-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <h3 className="font-semibold text-slate-100">{teamLabel(m.team)}</h3>
                    <button
                      type="button"
                      onClick={() => handleClearTeam(m)}
                      disabled={clearingTeamId === m.team.id || selectedCount === 0}
                      className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                    >
                      {clearingTeamId === m.team.id
                        ? "Marking…"
                        : `Mark Selected Done (${selectedCount})`}
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
                        <MoveTable
                          rows={m.moveOnto}
                          columnLabel="Old Team"
                          teamKey="oldTeam"
                          selected={selected}
                          onToggle={toggle}
                        />
                      )}
                    </div>

                    <div>
                      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Move Off Team {m.moveOff.length > 0 && <span className="text-slate-600">({m.moveOff.length})</span>}
                      </h4>
                      {m.moveOff.length === 0 ? (
                        <p className="text-sm text-slate-600">Nobody to remove.</p>
                      ) : (
                        <MoveTable
                          rows={m.moveOff}
                          columnLabel="New Team"
                          teamKey="newTeam"
                          selected={selected}
                          onToggle={toggle}
                        />
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}

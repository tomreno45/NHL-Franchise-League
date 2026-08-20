import { useEffect, useState } from "react";
import { api } from "../api";
import { useMyTeam } from "../MyTeamContext";
import CapBar from "./CapBar";

function slotLabel(lineupSlot) {
  return lineupSlot === "SCRATCH" ? "Scratched" : lineupSlot;
}

// The minors boundary only — call a player up (always lands on Scratch,
// same as a real recall; Set Lineup is where a coach actually inserts them
// into a line afterward) or send anyone on the active roster down. Kept
// separate from Set Lineup since "who's eligible to play at all" and "how
// are they arranged" are different decisions with different data (this
// tab needs cap hit front and center; line-editing doesn't).
export default function RosterMoves() {
  const { myTeamId, teams } = useMyTeam();
  const [roster, setRoster] = useState(null);
  const [slotsMeta, setSlotsMeta] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const reload = () => {
    if (myTeamId == null) return;
    api.getRoster(myTeamId).then(setRoster).catch((e) => setError(e.message));
  };

  useEffect(reload, [myTeamId]);

  useEffect(() => {
    api.getLineupSlots().then(setSlotsMeta).catch((e) => setError(e.message));
  }, []);

  const handleMove = async (playerId, targetSlot) => {
    setBusyId(playerId);
    setError(null);
    try {
      await api.assignLineupSlot({ teamId: myTeamId, playerId, targetSlot });
      reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  if (myTeamId == null || !roster || !slotsMeta) return <p className="text-slate-400">Loading roster…</p>;

  const myTeam = teams.find((t) => t.id === myTeamId) ?? roster.team;
  const activeRoster = roster.roster
    .filter((p) => p.lineupSlot !== slotsMeta.minorsSlot)
    .sort((a, b) => b.overall - a.overall);
  const minorsRoster = roster.roster
    .filter((p) => p.lineupSlot === slotsMeta.minorsSlot)
    .sort((a, b) => b.overall - a.overall);
  const scratchCount = activeRoster.filter((p) => p.lineupSlot === slotsMeta.scratchSlot).length;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="mb-1 text-lg font-semibold text-slate-100">{myTeam ? `${myTeam.city} ${myTeam.name}` : ""}</h2>
          <p className="text-sm text-slate-500">
            Call players up from the minors or send anyone down. A call-up lands on Scratch — use Set Lineup to slot
            them into an actual line afterward.
          </p>
        </div>
        <CapBar {...roster.capSummary} />
      </div>
      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-semibold text-slate-300">
            Active Roster ({activeRoster.length}) — Scratches {scratchCount}/{slotsMeta.maxScratches}
          </h3>
          <div className="overflow-x-auto rounded-lg bg-slate-900">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-800 text-left text-slate-400">
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Pos</th>
                  <th className="px-3 py-2 text-right font-medium">Age</th>
                  <th className="px-3 py-2 text-right font-medium">OVR</th>
                  <th className="px-3 py-2 text-right font-medium">Cap Hit</th>
                  <th className="px-3 py-2 font-medium">Slot</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {activeRoster.map((p, i) => (
                  <tr key={p.id} className={i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/50"}>
                    <td className="px-3 py-2 text-slate-100">{p.name}</td>
                    <td className="px-3 py-2 text-slate-300">{p.position}</td>
                    <td className="px-3 py-2 text-right text-slate-300">{p.age}</td>
                    <td className="px-3 py-2 text-right text-slate-300">{p.overall}</td>
                    <td className="px-3 py-2 text-right text-slate-300">${p.capHit.toFixed(2)}M</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{slotLabel(p.lineupSlot)}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => handleMove(p.id, slotsMeta.minorsSlot)}
                        disabled={busyId === p.id}
                        className="rounded-md bg-slate-700 px-2.5 py-1 text-xs font-medium text-slate-100 hover:bg-slate-600 disabled:opacity-50"
                      >
                        {busyId === p.id ? "…" : "Send Down"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold text-slate-300">Minors ({minorsRoster.length})</h3>
          <div className="overflow-x-auto rounded-lg bg-slate-900">
            {minorsRoster.length === 0 ? (
              <p className="px-3 py-2 text-sm text-slate-600">No players in the minors.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-800 text-left text-slate-400">
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Pos</th>
                    <th className="px-3 py-2 text-right font-medium">Age</th>
                    <th className="px-3 py-2 text-right font-medium">OVR</th>
                    <th className="px-3 py-2 text-right font-medium">Cap Hit</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {minorsRoster.map((p, i) => (
                    <tr key={p.id} className={i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/50"}>
                      <td className="px-3 py-2 text-slate-100">{p.name}</td>
                      <td className="px-3 py-2 text-slate-300">{p.position}</td>
                      <td className="px-3 py-2 text-right text-slate-300">{p.age}</td>
                      <td className="px-3 py-2 text-right text-slate-300">{p.overall}</td>
                      <td className="px-3 py-2 text-right text-slate-300">${p.capHit.toFixed(2)}M</td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => handleMove(p.id, slotsMeta.scratchSlot)}
                          disabled={busyId === p.id}
                          className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                        >
                          {busyId === p.id ? "…" : "Call Up"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

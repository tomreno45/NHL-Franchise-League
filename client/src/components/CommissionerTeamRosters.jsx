import { useEffect, useState } from "react";
import { api } from "../api";

function buildSlotLabeler(slotsMeta) {
  const labelBySlot = new Map(
    slotsMeta.slots.map((s) => [
      s.slot,
      s.group === "goalie" ? s.positionLabel : `${s.group === "forward" ? "Line" : "Pair"} ${s.line} · ${s.positionLabel}`,
    ])
  );
  labelBySlot.set(slotsMeta.scratchSlot, "Scratched");

  return (slot) => labelBySlot.get(slot) ?? slot;
}

export default function CommissionerTeamRosters() {
  const [teams, setTeams] = useState(null);
  const [rostersByTeam, setRostersByTeam] = useState(null);
  const [slotLabel, setSlotLabel] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([api.getTeams(), api.getLineupSlots()])
      .then(async ([allTeams, slotsMeta]) => {
        const humanTeams = allTeams.filter((t) => t.isHumanControlled);
        setTeams(humanTeams);
        setSlotLabel(() => buildSlotLabeler(slotsMeta));

        const rosters = await Promise.all(humanTeams.map((t) => api.getRoster(t.id)));
        const byTeam = new Map(humanTeams.map((t, i) => [t.id, rosters[i].roster]));
        setRostersByTeam(byTeam);
      })
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="text-red-500">{error}</p>;
  if (!teams || !rostersByTeam || !slotLabel) return <p className="text-slate-400">Loading rosters…</p>;

  return (
    <div>
      <p className="mb-4 text-sm text-slate-500">
        Every human team's dressed lines and scratches — minors aren't shown here, since they're not on the active
        roster. Head to My Team &gt; Set Lineup to edit your own.
      </p>

      <div className="flex flex-col gap-6">
        {teams.map((team) => {
          const roster = (rostersByTeam.get(team.id) ?? [])
            .filter((p) => p.lineupSlot !== "MINORS")
            .sort((a, b) => b.overall - a.overall);

          return (
            <div key={team.id} className="rounded-lg bg-slate-900 p-4">
              <h3 className="mb-3 font-semibold text-slate-100">
                {team.city} {team.name}
                <span className="ml-2 text-sm font-normal text-slate-500">{roster.length} players</span>
              </h3>
              <div className="overflow-x-auto rounded-lg">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-800 text-left text-slate-400">
                      <th className="px-3 py-2 font-medium">Name</th>
                      <th className="px-3 py-2 font-medium">Pos</th>
                      <th className="px-3 py-2 text-right font-medium">OVR</th>
                      <th className="px-3 py-2 font-medium">Assignment</th>
                    </tr>
                  </thead>
                  <tbody>
                    {roster.map((p, i) => (
                      <tr key={p.id} className={i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/50"}>
                        <td className="px-3 py-2 text-slate-100">{p.name}</td>
                        <td className="px-3 py-2 text-slate-300">{p.position}</td>
                        <td className="px-3 py-2 text-right text-slate-300">{p.overall}</td>
                        <td
                          className={`px-3 py-2 ${
                            p.lineupSlot === "SCRATCH" ? "text-amber-400" : "text-slate-300"
                          }`}
                        >
                          {slotLabel(p.lineupSlot)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

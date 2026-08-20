import { useEffect, useState } from "react";
import { api } from "../api";
import RosterTable from "./RosterTable";

export default function LeagueRosters() {
  const [teams, setTeams] = useState([]);
  const [teamId, setTeamId] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .getTeams()
      .then((t) => {
        setTeams(t);
        setTeamId((prev) => prev ?? t[0]?.id ?? null);
      })
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="text-red-500">{error}</p>;
  if (teams.length === 0) return <p className="text-slate-400">Loading teams…</p>;

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <label className="text-sm text-slate-400" htmlFor="rosters-team-select">
          Team
        </label>
        <select
          id="rosters-team-select"
          className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-slate-100"
          value={teamId ?? ""}
          onChange={(e) => setTeamId(Number(e.target.value))}
        >
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.city} {t.name}
              {t.isHumanControlled ? " (Human GM)" : ""}
            </option>
          ))}
        </select>
      </div>

      <RosterTable teamId={teamId} />
    </div>
  );
}

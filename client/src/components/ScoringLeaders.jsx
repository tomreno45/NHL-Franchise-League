import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import SortableHeader from "./SortableHeader";
import { sortRows } from "../sortUtils";

const SCORER_ACCESSORS = {
  name: (s) => s.name,
  team: (s) => `${s.team.city} ${s.team.name}`,
  position: (s) => s.position,
  gamesPlayed: (s) => s.gamesPlayed,
  goals: (s) => s.goals,
  assists: (s) => s.assists,
  points: (s) => s.points,
};

const GOALIE_ACCESSORS = {
  name: (g) => g.name,
  team: (g) => `${g.team.city} ${g.team.name}`,
  gamesPlayed: (g) => g.gamesPlayed,
  wins: (g) => g.wins,
  losses: (g) => g.losses,
  otLosses: (g) => g.otLosses,
  goalsAgainstAverage: (g) => g.goalsAgainstAverage,
  savePercentage: (g) => g.savePercentage,
  shutouts: (g) => g.shutouts,
};

export default function ScoringLeaders() {
  const [teams, setTeams] = useState([]);
  const [scorers, setScorers] = useState(null);
  const [goalies, setGoalies] = useState(null);
  const [teamFilter, setTeamFilter] = useState("");
  const [scorerSort, setScorerSort] = useState({ key: "points", dir: "desc" });
  const [goalieSort, setGoalieSort] = useState({ key: "wins", dir: "desc" });
  const [error, setError] = useState(null);

  // Fetched once, unfiltered — the team dropdown and column sorting both
  // just re-derive from this in memory rather than re-fetching, since the
  // whole league's skaters/goalies is a small enough dataset for that to be
  // instant either way.
  useEffect(() => {
    Promise.all([api.getTeams(), api.getScorers(), api.getGoalieLeaders()])
      .then(([t, s, g]) => {
        setTeams(t);
        setScorers(s);
        setGoalies(g);
      })
      .catch((e) => setError(e.message));
  }, []);

  const handleSort = (setSort) => (key) => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));
  };

  const filteredScorers = useMemo(() => {
    if (!scorers) return null;
    const filtered = teamFilter ? scorers.filter((s) => s.teamId === Number(teamFilter)) : scorers;
    return sortRows(filtered, SCORER_ACCESSORS, scorerSort.key, scorerSort.dir);
  }, [scorers, teamFilter, scorerSort]);

  const filteredGoalies = useMemo(() => {
    if (!goalies) return null;
    const filtered = teamFilter ? goalies.filter((g) => g.teamId === Number(teamFilter)) : goalies;
    return sortRows(filtered, GOALIE_ACCESSORS, goalieSort.key, goalieSort.dir);
  }, [goalies, teamFilter, goalieSort]);

  if (error) return <p className="text-red-500">{error}</p>;
  if (!filteredScorers || !filteredGoalies) return <p className="text-slate-400">Loading stats…</p>;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm text-slate-400" htmlFor="stats-team-filter">
          Team
        </label>
        <select
          id="stats-team-filter"
          className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-slate-100"
          value={teamFilter}
          onChange={(e) => setTeamFilter(e.target.value)}
        >
          <option value="">Whole League</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.city} {t.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-slate-300">Skater Stats</h2>
        <div className="overflow-x-auto rounded-lg"><table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-800 text-left text-slate-400">
              <th className="px-3 py-2 font-medium">Rank</th>
              <SortableHeader label="Player" sortKey="name" currentKey={scorerSort.key} direction={scorerSort.dir} onSort={handleSort(setScorerSort)} />
              <SortableHeader label="Team" sortKey="team" currentKey={scorerSort.key} direction={scorerSort.dir} onSort={handleSort(setScorerSort)} />
              <SortableHeader label="Pos" sortKey="position" currentKey={scorerSort.key} direction={scorerSort.dir} onSort={handleSort(setScorerSort)} />
              <SortableHeader label="GP" sortKey="gamesPlayed" currentKey={scorerSort.key} direction={scorerSort.dir} onSort={handleSort(setScorerSort)} align="right" />
              <SortableHeader label="G" sortKey="goals" currentKey={scorerSort.key} direction={scorerSort.dir} onSort={handleSort(setScorerSort)} align="right" />
              <SortableHeader label="A" sortKey="assists" currentKey={scorerSort.key} direction={scorerSort.dir} onSort={handleSort(setScorerSort)} align="right" />
              <SortableHeader label="PTS" sortKey="points" currentKey={scorerSort.key} direction={scorerSort.dir} onSort={handleSort(setScorerSort)} align="right" />
            </tr>
          </thead>
          <tbody>
            {filteredScorers.map((s, i) => (
              <tr key={s.playerId} className={i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/50"}>
                <td className="px-3 py-2 text-slate-400">{i + 1}</td>
                <td className="px-3 py-2 text-slate-100">{s.name}</td>
                <td className="px-3 py-2 text-slate-300">
                  {s.team.city} {s.team.name}
                </td>
                <td className="px-3 py-2 text-slate-300">{s.position}</td>
                <td className="px-3 py-2 text-right text-slate-300">{s.gamesPlayed}</td>
                <td className={`px-3 py-2 text-right ${scorerSort.key === "goals" ? "font-semibold text-slate-100" : "text-slate-300"}`}>
                  {s.goals}
                </td>
                <td className={`px-3 py-2 text-right ${scorerSort.key === "assists" ? "font-semibold text-slate-100" : "text-slate-300"}`}>
                  {s.assists}
                </td>
                <td className={`px-3 py-2 text-right ${scorerSort.key === "points" ? "font-semibold text-slate-100" : "text-slate-300"}`}>
                  {s.points}
                </td>
              </tr>
            ))}
            {filteredScorers.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-4 text-center text-slate-500">
                  No skaters found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-slate-300">Goalie Stats</h2>
        <div className="overflow-x-auto rounded-lg"><table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-800 text-left text-slate-400">
              <th className="px-3 py-2 font-medium">Rank</th>
              <SortableHeader label="Player" sortKey="name" currentKey={goalieSort.key} direction={goalieSort.dir} onSort={handleSort(setGoalieSort)} />
              <SortableHeader label="Team" sortKey="team" currentKey={goalieSort.key} direction={goalieSort.dir} onSort={handleSort(setGoalieSort)} />
              <SortableHeader label="GP" sortKey="gamesPlayed" currentKey={goalieSort.key} direction={goalieSort.dir} onSort={handleSort(setGoalieSort)} align="right" />
              <SortableHeader label="W" sortKey="wins" currentKey={goalieSort.key} direction={goalieSort.dir} onSort={handleSort(setGoalieSort)} align="right" />
              <SortableHeader label="L" sortKey="losses" currentKey={goalieSort.key} direction={goalieSort.dir} onSort={handleSort(setGoalieSort)} align="right" />
              <SortableHeader label="OTL" sortKey="otLosses" currentKey={goalieSort.key} direction={goalieSort.dir} onSort={handleSort(setGoalieSort)} align="right" />
              <SortableHeader label="GAA" sortKey="goalsAgainstAverage" currentKey={goalieSort.key} direction={goalieSort.dir} onSort={handleSort(setGoalieSort)} align="right" />
              <SortableHeader label="SV%" sortKey="savePercentage" currentKey={goalieSort.key} direction={goalieSort.dir} onSort={handleSort(setGoalieSort)} align="right" />
              <SortableHeader label="SO" sortKey="shutouts" currentKey={goalieSort.key} direction={goalieSort.dir} onSort={handleSort(setGoalieSort)} align="right" />
            </tr>
          </thead>
          <tbody>
            {filteredGoalies.map((g, i) => (
              <tr key={g.playerId} className={i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/50"}>
                <td className="px-3 py-2 text-slate-400">{i + 1}</td>
                <td className="px-3 py-2 text-slate-100">{g.name}</td>
                <td className="px-3 py-2 text-slate-300">
                  {g.team.city} {g.team.name}
                </td>
                <td className="px-3 py-2 text-right text-slate-300">{g.gamesPlayed}</td>
                <td className="px-3 py-2 text-right font-semibold text-slate-100">{g.wins}</td>
                <td className="px-3 py-2 text-right text-slate-300">{g.losses}</td>
                <td className="px-3 py-2 text-right text-slate-300">{g.otLosses}</td>
                <td className="px-3 py-2 text-right text-slate-300">{g.goalsAgainstAverage.toFixed(2)}</td>
                <td className="px-3 py-2 text-right text-slate-300">{g.savePercentage.toFixed(3)}</td>
                <td className="px-3 py-2 text-right text-slate-300">{g.shutouts}</td>
              </tr>
            ))}
            {filteredGoalies.length === 0 && (
              <tr>
                <td colSpan={10} className="px-3 py-4 text-center text-slate-500">
                  No goalies found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}

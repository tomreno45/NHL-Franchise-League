import { useEffect, useState } from "react";
import { api } from "../api";
import TeamLogo from "./TeamLogo";

export default function Standings() {
  const [standings, setStandings] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getStandings().then(setStandings).catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="text-red-500">{error}</p>;
  if (!standings) return <p className="text-slate-400">Loading standings…</p>;

  const byConference = standings.reduce((acc, team) => {
    (acc[team.conference] ||= []).push(team);
    return acc;
  }, {});

  return (
    <div className="grid gap-8 md:grid-cols-2">
      {Object.entries(byConference).map(([conference, teams]) => (
        <div key={conference}>
          <h2 className="mb-2 text-lg font-semibold text-slate-100">{conference} Conference</h2>
          <div className="overflow-x-auto rounded-lg">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-800 text-left text-slate-400">
                  <th className="px-3 py-2 font-medium">Team</th>
                  <th className="px-3 py-2 text-right font-medium">GP</th>
                  <th className="px-3 py-2 text-right font-medium">W</th>
                  <th className="px-3 py-2 text-right font-medium">L</th>
                  <th className="px-3 py-2 text-right font-medium">OTL</th>
                  <th className="px-3 py-2 text-right font-medium">PTS</th>
                  <th className="px-3 py-2 text-right font-medium">GF</th>
                  <th className="px-3 py-2 text-right font-medium">GA</th>
                </tr>
              </thead>
              <tbody>
                {teams.map((t, i) => (
                  <tr
                    key={t.teamId}
                    className={i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/50"}
                  >
                    <td className="whitespace-nowrap px-3 py-2 text-slate-100">
                      <div className="flex items-center gap-2">
                        <TeamLogo abbr={t.abbr} size={22} />
                        {t.city} {t.name}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right text-slate-300">{t.gamesPlayed}</td>
                    <td className="px-3 py-2 text-right text-slate-300">{t.wins}</td>
                    <td className="px-3 py-2 text-right text-slate-300">{t.losses}</td>
                    <td className="px-3 py-2 text-right text-slate-300">{t.otLosses}</td>
                    <td className="px-3 py-2 text-right font-semibold text-slate-100">
                      {t.points}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-300">{t.goalsFor}</td>
                    <td className="px-3 py-2 text-right text-slate-300">{t.goalsAgainst}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

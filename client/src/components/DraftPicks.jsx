import { useEffect, useState } from "react";
import { api } from "../api";
import TradeValueBar from "./TradeValueBar";
import { draftYear } from "../seasonYear";

export default function DraftPicks() {
  const [teams, setTeams] = useState([]);
  const [teamId, setTeamId] = useState("");
  const [picks, setPicks] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getTeams().then(setTeams).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    api
      .getDraftPicks(teamId || undefined)
      .then(setPicks)
      .catch((e) => setError(e.message));
  }, [teamId]);

  if (error) return <p className="text-red-500">{error}</p>;
  if (!picks) return <p className="text-slate-400">Loading draft picks…</p>;

  // Picks now span every year currently open for trading (see
  // DRAFT_TRADE_WINDOW server-side), so group by year first, then round
  // within each year.
  const bySeason = picks.reduce((acc, p) => {
    (acc[p.seasonNumber] ||= []).push(p);
    return acc;
  }, {});

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <label className="text-sm text-slate-400" htmlFor="pick-team">
          Currently Held By
        </label>
        <select
          id="pick-team"
          className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-slate-100"
          value={teamId}
          onChange={(e) => setTeamId(e.target.value)}
        >
          <option value="">All Teams (full draft board)</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.city} {t.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-8">
        {Object.keys(bySeason)
          .sort((a, b) => a - b)
          .map((seasonNumber) => {
            const seasonPicks = bySeason[seasonNumber];
            const byRound = seasonPicks.reduce((acc, p) => {
              (acc[p.round] ||= []).push(p);
              return acc;
            }, {});

            return (
              <div key={seasonNumber}>
                <h2 className="mb-3 text-lg font-semibold text-slate-100">{draftYear(Number(seasonNumber))} NHL Draft</h2>
                <div className="flex flex-col gap-6">
                  {Object.keys(byRound)
                    .sort((a, b) => a - b)
                    .map((round) => (
                      <div key={round}>
                        <h3 className="mb-2 text-sm font-semibold text-slate-300">Round {round}</h3>
                        <div className="overflow-x-auto rounded-lg"><table className="w-full text-sm">
                          <thead>
                            <tr className="bg-slate-800 text-left text-slate-400">
                              <th className="px-3 py-2 text-right font-medium">Pick #</th>
                              <th className="px-3 py-2 font-medium">Original Team</th>
                              <th className="px-3 py-2 font-medium">Current Owner</th>
                              <th className="px-3 py-2 font-medium">Trade Value</th>
                            </tr>
                          </thead>
                          <tbody>
                            {byRound[round]
                              .sort((a, b) => a.positionInRound - b.positionInRound)
                              .map((p, i) => (
                                <tr key={p.id} className={i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/50"}>
                                  <td className="px-3 py-2 text-right text-slate-300">{p.overallPickNumber}</td>
                                  <td className="px-3 py-2 text-slate-100">
                                    {p.originalTeam.city} {p.originalTeam.name}
                                  </td>
                                  <td className="px-3 py-2 text-slate-300">
                                    {p.currentTeam.id === p.originalTeam.id ? (
                                      <span className="text-slate-500">—</span>
                                    ) : (
                                      `${p.currentTeam.city} ${p.currentTeam.name}`
                                    )}
                                  </td>
                                  <td className="px-3 py-2">
                                    <TradeValueBar value={p.tradeValue} />
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}

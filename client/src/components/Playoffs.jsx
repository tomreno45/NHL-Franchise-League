import { useEffect, useState } from "react";
import { api } from "../api";
import PlayoffBracket from "./PlayoffBracket";

const SKATER_LIMIT = 25;

function Table({ columns, rows, rowKey }) {
  return (
    <div className="overflow-x-auto rounded-lg">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-slate-800 text-left text-slate-400">
            {columns.map((c) => (
              <th key={c.label} className={`px-3 py-2 font-medium ${c.right ? "text-right" : ""}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={rowKey(r)} className={i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/50"}>
              {columns.map((c) => (
                <td key={c.label} className={`px-3 py-1.5 text-slate-200 ${c.right ? "text-right" : ""}`}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const teamName = (t) => `${t.city} ${t.name}`;

export default function Playoffs() {
  const [bracket, setBracket] = useState(null);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [showAllSkaters, setShowAllSkaters] = useState(false);

  useEffect(() => {
    Promise.all([api.getPlayoffBracket(), api.getPlayoffStats()])
      .then(([b, s]) => {
        setBracket(b);
        setStats(s);
      })
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="text-red-500">{error}</p>;
  if (!bracket || !stats) return <p className="text-slate-400">Loading playoffs…</p>;

  const skaters = showAllSkaters ? stats.skaters : stats.skaters.slice(0, SKATER_LIMIT);

  return (
    <div className="flex flex-col gap-8">
      {bracket.champion && (
        <div className="rounded-lg bg-emerald-500/10 px-4 py-3 text-emerald-300">
          🏆 {teamName(bracket.champion)} — Season {bracket.seasonNumber} champions
        </div>
      )}

      <section>
        <h2 className="mb-3 text-lg font-semibold text-slate-100">Playoff Bracket</h2>
        {bracket.started ? (
          <PlayoffBracket bracket={bracket} />
        ) : (
          <p className="text-sm text-slate-500">
            The bracket will appear here once the commissioner sets the playoff field ({bracket.fieldSize} teams,
            best-of-{bracket.bestOf} series).
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-slate-100">Playoff Scoring Leaders</h2>
        {stats.skaters.length === 0 ? (
          <p className="text-sm text-slate-500">No playoff stats yet.</p>
        ) : (
          <>
            <Table
              rowKey={(r) => r.playerId}
              rows={skaters}
              columns={[
                { label: "Name", render: (r) => r.name },
                { label: "Team", render: (r) => r.team.abbr },
                { label: "Pos", render: (r) => r.position },
                { label: "GP", right: true, render: (r) => r.gamesPlayed },
                { label: "G", right: true, render: (r) => r.goals },
                { label: "A", right: true, render: (r) => r.assists },
                { label: "P", right: true, render: (r) => r.points },
              ]}
            />
            {stats.skaters.length > SKATER_LIMIT && (
              <button
                type="button"
                onClick={() => setShowAllSkaters((v) => !v)}
                className="mt-2 text-xs font-medium text-slate-400 hover:text-sky-400"
              >
                {showAllSkaters ? `Show top ${SKATER_LIMIT}` : `Show all ${stats.skaters.length}`}
              </button>
            )}
          </>
        )}
      </section>

      {stats.goalies.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold text-slate-100">Playoff Goalies</h2>
          <Table
            rowKey={(r) => r.playerId}
            rows={stats.goalies}
            columns={[
              { label: "Name", render: (r) => r.name },
              { label: "Team", render: (r) => r.team.abbr },
              { label: "GP", right: true, render: (r) => r.gamesPlayed },
              { label: "W", right: true, render: (r) => r.wins },
              { label: "L", right: true, render: (r) => r.losses },
              { label: "OTL", right: true, render: (r) => r.otLosses },
              { label: "GAA", right: true, render: (r) => r.goalsAgainstAverage.toFixed(2) },
              { label: "SV%", right: true, render: (r) => r.savePercentage.toFixed(3) },
              { label: "SO", right: true, render: (r) => r.shutouts },
            ]}
          />
        </section>
      )}
    </div>
  );
}

import TeamLogo from "./TeamLogo";

function TeamRow({ side, isWinner, decided }) {
  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 ${
        isWinner ? "bg-emerald-500/10" : decided ? "opacity-50" : ""
      }`}
    >
      <span className="w-4 text-xs text-slate-500">{side.seed}</span>
      <TeamLogo abbr={side.team.abbr} size={24} />
      <span className={`min-w-0 flex-1 truncate text-sm ${isWinner ? "font-semibold text-slate-100" : "text-slate-200"}`}>
        {side.team.city} {side.team.name}
      </span>
      <span className={`text-base font-semibold ${isWinner ? "text-emerald-400" : "text-slate-300"}`}>{side.wins}</span>
    </div>
  );
}

function SeriesCard({ series, renderGameAction }) {
  const decided = Boolean(series.winner);
  return (
    <div className="overflow-hidden rounded-lg bg-slate-900">
      <TeamRow side={series.high} isWinner={decided && series.winner.id === series.high.team.id} decided={decided} />
      <TeamRow side={series.low} isWinner={decided && series.winner.id === series.low.team.id} decided={decided} />
      {series.games.length > 0 && (
        <div className="border-t border-white/5 px-3 py-2">
          {series.games.map((g) => (
            <div key={g.id} className="flex items-center gap-2 py-0.5 text-xs text-slate-400">
              <span className="w-8 shrink-0 text-slate-500">G{g.gameNumber}</span>
              <span className="min-w-0 flex-1 truncate">
                {g.awayTeam.abbr} @ {g.homeTeam.abbr}
              </span>
              {g.status === "final" ? (
                <span className="shrink-0 text-slate-200">
                  {g.awayScore}–{g.homeScore}
                  {g.wentToOT ? " OT" : ""}
                </span>
              ) : (
                <span className="shrink-0 text-slate-600">
                  {g.gameType === "human_vs_human" ? "Console" : "Simmed"}
                </span>
              )}
              {renderGameAction?.(g, series)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// The bracket as one column per round. `renderGameAction(game, series)` is
// optional — the commissioner's page uses it to put Enter Score / Sim buttons
// beside each game; the League tab leaves it off to stay read-only.
export default function PlayoffBracket({ bracket, renderGameAction }) {
  return (
    <div className="flex gap-4 overflow-x-auto pb-2">
      {bracket.rounds.map((round) => (
        <div key={round.round} className="flex min-w-[17rem] flex-1 flex-col">
          <p className="hub-label mb-2">{round.name}</p>
          <div className="flex flex-1 flex-col justify-around gap-3">
            {round.series.map((s, i) =>
              s ? (
                <SeriesCard key={s.id} series={s} renderGameAction={renderGameAction} />
              ) : (
                <div
                  key={`tbd-${round.round}-${i}`}
                  className="rounded-lg border border-dashed border-slate-800 px-3 py-6 text-center text-xs text-slate-600"
                >
                  To be determined
                </div>
              )
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

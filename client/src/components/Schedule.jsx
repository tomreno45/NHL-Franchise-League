import { useEffect, useState } from "react";
import { api } from "../api";
import GameScoreModal from "./GameScoreModal";
import TeamLogo from "./TeamLogo";

const GAME_TYPE_LABELS = {
  human_vs_human: "Console",
  human_vs_cpu: "Simmed",
  cpu_vs_cpu: "Simmed",
};

const GAME_TYPE_STYLES = {
  human_vs_human: "bg-sky-500/15 text-sky-400",
  human_vs_cpu: "bg-slate-500/15 text-slate-400",
  cpu_vs_cpu: "bg-slate-500/15 text-slate-400",
};

export default function Schedule() {
  const [teams, setTeams] = useState([]);
  // Two optional team filters: one narrows to that team's games, both narrow
  // to the games between those two teams — handy for finding a console
  // matchup to score without scrolling the whole schedule.
  const [teamId, setTeamId] = useState("");
  const [opponentId, setOpponentId] = useState("");
  const [games, setGames] = useState(null);
  const [error, setError] = useState(null);
  const [scoreGame, setScoreGame] = useState(null);
  const [advancing, setAdvancing] = useState(false);
  const [advanceMessage, setAdvanceMessage] = useState(null);

  const reload = () => {
    api
      .getSchedule(teamId || opponentId || undefined)
      .then(setGames)
      .catch((e) => setError(e.message));
  };

  useEffect(() => {
    api.getTeams().then(setTeams).catch((e) => setError(e.message));
  }, []);

  useEffect(reload, [teamId, opponentId]);

  const visibleGames =
    games && teamId && opponentId
      ? games.filter((g) => g.homeTeam.id === Number(opponentId) || g.awayTeam.id === Number(opponentId))
      : games;

  const handleSaved = () => {
    setScoreGame(null);
    reload();
  };

  const handleAdvance = async () => {
    setAdvancing(true);
    setAdvanceMessage(null);
    try {
      const result = await api.advanceSimulation();
      setAdvanceMessage(`Simmed ${result.simmedCount} CPU-involved game(s).`);
      reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setAdvancing(false);
    }
  };

  if (error) return <p className="text-red-500">{error}</p>;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="text-sm text-slate-400" htmlFor="schedule-team">
          Team
        </label>
        <select
          id="schedule-team"
          className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-slate-100"
          value={teamId}
          onChange={(e) => setTeamId(e.target.value)}
        >
          <option value="">All Teams</option>
          {teams
            .filter((t) => String(t.id) !== opponentId)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.city} {t.name}
              </option>
            ))}
        </select>

        <label className="text-sm text-slate-400" htmlFor="schedule-opponent">
          vs
        </label>
        <select
          id="schedule-opponent"
          className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-slate-100"
          value={opponentId}
          onChange={(e) => setOpponentId(e.target.value)}
        >
          <option value="">Any Team</option>
          {teams
            .filter((t) => String(t.id) !== teamId)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.city} {t.name}
              </option>
            ))}
        </select>

        <button
          type="button"
          onClick={handleAdvance}
          disabled={advancing}
          className="ml-auto rounded-md bg-slate-800 px-3 py-1.5 text-sm font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-50"
        >
          {advancing ? "Simming…" : "Advance CPU Simulation"}
        </button>
        {advanceMessage && <span className="text-sm text-emerald-400">{advanceMessage}</span>}
      </div>

      {!games ? (
        <p className="text-slate-400">Loading schedule…</p>
      ) : (
        <div className="flex flex-col gap-2">
          {visibleGames.length === 0 && <p className="text-slate-500">No games match these teams.</p>}
          {visibleGames.map((g) => (
            <div key={g.id} className="rounded-lg bg-slate-900 px-4 py-3 text-sm">
              <div className="mb-2.5 flex items-center justify-between">
                <span className="text-xs text-slate-500">{g.date}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${GAME_TYPE_STYLES[g.gameType]}`}
                >
                  {GAME_TYPE_LABELS[g.gameType]}
                </span>
              </div>
              <div className="flex items-center gap-2 sm:gap-3">
                <div className="flex flex-1 items-center justify-end gap-2 text-right text-slate-100">
                  <span>
                    {g.awayTeam.city} {g.awayTeam.name}
                  </span>
                  <TeamLogo abbr={g.awayTeam.abbr} size={28} />
                </div>
                <div className="shrink-0 text-center text-base font-semibold text-slate-100">
                  {g.status === "final" ? `${g.awayScore} – ${g.homeScore}${g.wentToOT ? " OT" : ""}` : "vs"}
                </div>
                <div className="flex flex-1 items-center gap-2 text-slate-100">
                  <TeamLogo abbr={g.homeTeam.abbr} size={28} />
                  <span>
                    {g.homeTeam.city} {g.homeTeam.name}
                  </span>
                </div>
              </div>
              <div className="mt-2.5 flex justify-end">
                {g.needsScore ? (
                  <button
                    type="button"
                    onClick={() => setScoreGame(g)}
                    className="rounded-md bg-amber-500/15 px-3 py-1.5 text-xs font-medium text-amber-400 hover:bg-amber-500/25"
                  >
                    Enter Score
                  </button>
                ) : g.gameType === "human_vs_human" && g.status === "final" ? (
                  <button
                    type="button"
                    onClick={() => setScoreGame(g)}
                    className="text-xs font-medium text-slate-500 hover:text-sky-400"
                  >
                    Final — Edit
                  </button>
                ) : (
                  <span
                    className={`text-xs font-medium ${g.status === "final" ? "text-emerald-400" : "text-slate-500"}`}
                  >
                    {g.status === "final" ? "Final" : "Scheduled"}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {scoreGame && (
        <GameScoreModal game={scoreGame} onClose={() => setScoreGame(null)} onSaved={handleSaved} />
      )}
    </div>
  );
}

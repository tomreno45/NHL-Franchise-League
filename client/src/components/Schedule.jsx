import { useEffect, useState } from "react";
import { api } from "../api";
import GameBoxScoreModal from "./GameBoxScoreModal";
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
  const [teamId, setTeamId] = useState("");
  const [games, setGames] = useState(null);
  const [error, setError] = useState(null);
  const [boxScoreGame, setBoxScoreGame] = useState(null);
  const [advancing, setAdvancing] = useState(false);
  const [advanceMessage, setAdvanceMessage] = useState(null);

  const reload = () => {
    api
      .getSchedule(teamId || undefined)
      .then(setGames)
      .catch((e) => setError(e.message));
  };

  useEffect(() => {
    api.getTeams().then(setTeams).catch((e) => setError(e.message));
  }, []);

  useEffect(reload, [teamId]);

  const handleSaved = () => {
    setBoxScoreGame(null);
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
          {teams.map((t) => (
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
        <div className="flex flex-col gap-1.5">
          {games.map((g) => (
            <div key={g.id} className="flex items-center justify-between rounded-lg bg-slate-900 px-4 py-2.5 text-sm">
              <span className="w-24 text-slate-400">{g.date}</span>
              <span className="flex flex-1 items-center justify-end gap-2 text-right text-slate-100">
                {g.awayTeam.city} {g.awayTeam.name}
                <TeamLogo abbr={g.awayTeam.abbr} size={22} />
              </span>
              <span className="w-20 text-center font-semibold text-slate-100">
                {g.status === "final" ? `${g.awayScore} – ${g.homeScore}${g.wentToOT ? " OT" : ""}` : "vs"}
              </span>
              <span className="flex flex-1 items-center gap-2 text-slate-100">
                <TeamLogo abbr={g.homeTeam.abbr} size={22} />
                {g.homeTeam.city} {g.homeTeam.name}
              </span>
              <span
                className={`w-20 rounded-full px-2 py-0.5 text-center text-xs font-medium ${GAME_TYPE_STYLES[g.gameType]}`}
              >
                {GAME_TYPE_LABELS[g.gameType]}
              </span>
              <span className="w-32 text-right">
                {g.needsScore ? (
                  <button
                    type="button"
                    onClick={() => setBoxScoreGame(g)}
                    className="rounded-md bg-amber-500/15 px-2 py-1 text-xs font-medium text-amber-400 hover:bg-amber-500/25"
                  >
                    Enter Box Score
                  </button>
                ) : g.gameType === "human_vs_human" && g.status === "final" ? (
                  <button
                    type="button"
                    onClick={() => setBoxScoreGame(g)}
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
              </span>
            </div>
          ))}
        </div>
      )}

      {boxScoreGame && (
        <GameBoxScoreModal game={boxScoreGame} onClose={() => setBoxScoreGame(null)} onSaved={handleSaved} />
      )}
    </div>
  );
}

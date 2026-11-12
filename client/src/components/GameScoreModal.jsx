import { useState } from "react";
import { api } from "../api";
import TeamLogo from "./TeamLogo";

function ScoreInput({ team, value, onChange }) {
  return (
    <div className="flex flex-1 flex-col items-center gap-2">
      <TeamLogo abbr={team.abbr} size={40} />
      <span className="text-sm text-slate-300">
        {team.city} {team.name}
      </span>
      <input
        type="number"
        min="0"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-20 rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-center text-2xl font-semibold text-slate-100"
      />
    </div>
  );
}

// A console game is reported as just its final score (and whether it went to
// OT) — the players' stats from these games are entered separately, as
// season totals, in the commissioner's User Game Stats tab.
export default function GameScoreModal({ game, onClose, onSaved }) {
  const [awayScore, setAwayScore] = useState(game.status === "final" ? String(game.awayScore) : "");
  const [homeScore, setHomeScore] = useState(game.status === "final" ? String(game.homeScore) : "");
  const [wentToOT, setWentToOT] = useState(Boolean(game.wentToOT));
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    if (awayScore === "" || homeScore === "") {
      setError("Enter both scores.");
      return;
    }
    if (Number(awayScore) === Number(homeScore)) {
      setError("The score can't end tied — include the OT winner's goal.");
      return;
    }

    setSubmitting(true);
    try {
      const updated = await api.submitScore(game.id, {
        wentToOT,
        homeScore: Number(homeScore),
        awayScore: Number(awayScore),
      });
      onSaved(updated);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-lg bg-slate-900 p-6">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-100">
              {game.awayTeam.abbr} @ {game.homeTeam.abbr} — Final Score
            </h2>
            <p className="text-xs text-slate-500">{game.date}</p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-slate-300">
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="mb-4 flex items-start gap-4">
            <ScoreInput team={game.awayTeam} value={awayScore} onChange={setAwayScore} />
            <span className="pt-16 text-slate-600">@</span>
            <ScoreInput team={game.homeTeam} value={homeScore} onChange={setHomeScore} />
          </div>

          <label className="mb-4 flex items-center justify-center gap-2 text-sm text-slate-400">
            <input type="checkbox" checked={wentToOT} onChange={(e) => setWentToOT(e.target.checked)} />
            Went to OT
          </label>

          {error && <p className="mb-3 text-center text-sm text-red-400">{error}</p>}

          <div className="flex items-center justify-end gap-3 border-t border-slate-800 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-sm text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            >
              {submitting ? "Saving…" : "Save Score"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

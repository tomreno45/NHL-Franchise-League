import { useState } from "react";
import { api } from "../api";
import { useAuth } from "../AuthContext";
import { useLeaguePhase } from "../LeaguePhaseContext";
import { PHASE_LABELS } from "../phaseLabels";
import { seasonYearLabel } from "../seasonYear";

export default function PhaseBanner() {
  const { user } = useAuth();
  const { phase, error, setPhase } = useLeaguePhase();
  const [advancing, setAdvancing] = useState(false);
  const [advanceError, setAdvanceError] = useState(null);

  const handleAdvance = async () => {
    setAdvancing(true);
    setAdvanceError(null);
    try {
      setPhase(await api.advancePhase());
    } catch (e) {
      setAdvanceError(e.message);
    } finally {
      setAdvancing(false);
    }
  };

  if (error) return <div className="border-b border-white/5 bg-black/20 px-6 py-2 text-sm text-red-400">{error}</div>;
  if (!phase) return null;

  const label = PHASE_LABELS[phase.phase] || phase.phase;

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-white/5 bg-black/20 px-6 py-2 text-sm">
      <span className="hub-label">{seasonYearLabel(phase.seasonNumber)} Season</span>
      <span className="text-slate-700">·</span>
      <span className="font-semibold text-cyan-300">{label}</span>
      {phase.totalRounds > 1 && (
        <span className="text-slate-400">
          Round {phase.phaseRound} of {phase.totalRounds}
        </span>
      )}
      {advanceError && <span className="text-red-400">{advanceError}</span>}
      {user.role === "commissioner" && (
        <button
          type="button"
          onClick={handleAdvance}
          disabled={advancing}
          className="ml-auto rounded-md bg-cyan-500 px-3 py-1 text-xs font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
        >
          {advancing ? "Advancing…" : "Advance Phase"}
        </button>
      )}
    </div>
  );
}

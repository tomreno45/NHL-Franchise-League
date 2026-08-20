import { PHASE_LABELS, PHASE_ORDER } from "../phaseLabels";
import { useLeaguePhase } from "../LeaguePhaseContext";
import { seasonYearLabel } from "../seasonYear";

export default function LeagueFlow() {
  const { phase } = useLeaguePhase();

  if (!phase) return null;

  const currentIndex = PHASE_ORDER.indexOf(phase.phase);

  return (
    <div className="rounded-lg bg-slate-900 p-5">
      <h3 className="mb-1 text-base font-semibold text-slate-100">League Flow</h3>
      <p className="mb-4 text-sm text-slate-500">
        {seasonYearLabel(phase.seasonNumber)} Season — the full cycle each season moves through, in order. Loops
        back to Free Agency once Re-signing wraps up.
      </p>
      <div className="flex flex-wrap items-center gap-y-3">
        {PHASE_ORDER.map((p, idx) => {
          const isCurrent = idx === currentIndex;
          const isPast = currentIndex >= 0 && idx < currentIndex;
          return (
            <div key={p} className="flex items-center">
              {idx > 0 && <span className="mx-1.5 text-slate-700 sm:mx-2">→</span>}
              <div
                className={
                  "rounded-full border px-3 py-1.5 text-xs font-medium whitespace-nowrap sm:text-sm " +
                  (isCurrent
                    ? "border-sky-400 bg-sky-500/20 text-sky-300 ring-2 ring-sky-500/40"
                    : isPast
                    ? "border-slate-700 bg-slate-800/60 text-slate-500"
                    : "border-slate-800 bg-slate-950 text-slate-400")
                }
              >
                {PHASE_LABELS[p]}
                {isCurrent && phase.totalRounds > 1 && (
                  <span className="ml-1.5 text-sky-400/80">
                    · Round {phase.phaseRound}/{phase.totalRounds}
                  </span>
                )}
              </div>
            </div>
          );
        })}
        <span className="mx-1.5 text-slate-700 sm:mx-2">↻</span>
      </div>
    </div>
  );
}

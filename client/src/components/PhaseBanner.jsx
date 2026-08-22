import { useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../AuthContext";
import { useLeaguePhase } from "../LeaguePhaseContext";
import { useMyTeam } from "../MyTeamContext";
import { PHASE_LABELS } from "../phaseLabels";
import { seasonYearLabel } from "../seasonYear";

// How often to poll for other GMs' ready state (and a phase/round the
// commissioner — or the ready system itself — may have advanced without
// this tab knowing). No websockets in this app, so polling is the simple
// way everyone sees the live "3/5 ready" count tick up.
const POLL_INTERVAL_MS = 5000;

export default function PhaseBanner() {
  const { user } = useAuth();
  const { myTeamId } = useMyTeam();
  const { phase, error, setPhase, reload } = useLeaguePhase();
  const [advancing, setAdvancing] = useState(false);
  const [advanceError, setAdvanceError] = useState(null);

  const [readyStatus, setReadyStatus] = useState(null);
  const [togglingReady, setTogglingReady] = useState(false);
  const [readyError, setReadyError] = useState(null);

  const reloadReady = () => api.getReadyStatus().then(setReadyStatus).catch(() => {});

  useEffect(() => {
    reloadReady();
    const id = setInterval(reloadReady, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  // The poll is also how this tab finds out the phase moved on — whether
  // because everyone just finished readying up, someone else's ready click
  // was the one that tipped it over, or the commissioner advanced manually
  // from elsewhere — rather than sitting on a stale phase/round display.
  useEffect(() => {
    if (!readyStatus || !phase) return;
    if (readyStatus.phase !== phase.phase || readyStatus.phaseRound !== phase.phaseRound) {
      reload();
    }
  }, [readyStatus, phase, reload]);

  const handleAdvance = async () => {
    setAdvancing(true);
    setAdvanceError(null);
    try {
      setPhase(await api.advancePhase());
      reloadReady();
    } catch (e) {
      setAdvanceError(e.message);
    } finally {
      setAdvancing(false);
    }
  };

  const handleToggleReady = async () => {
    if (!readyStatus) return;
    const mine = readyStatus.teams.find((t) => t.teamId === myTeamId);
    setTogglingReady(true);
    setReadyError(null);
    try {
      const result = await api.setReady(!mine?.ready);
      setReadyStatus(result.status);
      if (result.advanced) reload();
    } catch (e) {
      setReadyError(e.message);
    } finally {
      setTogglingReady(false);
    }
  };

  if (error) return <div className="border-b border-white/5 bg-black/20 px-6 py-2 text-sm text-red-400">{error}</div>;
  if (!phase) return null;

  const label = PHASE_LABELS[phase.phase] || phase.phase;
  const myReadyEntry = readyStatus?.teams.find((t) => t.teamId === myTeamId);

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

      {readyStatus && readyStatus.totalCount > 0 && (
        <span className="text-slate-400">
          {readyStatus.readyCount}/{readyStatus.totalCount} ready
        </span>
      )}

      {advanceError && <span className="text-red-400">{advanceError}</span>}
      {readyError && <span className="text-red-400">{readyError}</span>}

      <div className="ml-auto flex items-center gap-2">
        {myReadyEntry && (
          <button
            type="button"
            onClick={handleToggleReady}
            disabled={togglingReady}
            className={`rounded-md px-3 py-1 text-xs font-semibold disabled:opacity-50 ${
              myReadyEntry.ready
                ? "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25"
                : "bg-slate-700 text-slate-100 hover:bg-slate-600"
            }`}
          >
            {togglingReady ? "…" : myReadyEntry.ready ? "Ready ✓" : "Ready?"}
          </button>
        )}
        {user.role === "commissioner" && (
          <button
            type="button"
            onClick={handleAdvance}
            disabled={advancing}
            className="rounded-md bg-cyan-500 px-3 py-1 text-xs font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
          >
            {advancing ? "Advancing…" : "Advance Phase"}
          </button>
        )}
      </div>
    </div>
  );
}

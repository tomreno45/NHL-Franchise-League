import { useEffect, useMemo, useState } from "react";
import { api } from "../api";

const SLOT_ORDER = [
  "F1_LW",
  "F1_C",
  "F1_RW",
  "F2_LW",
  "F2_C",
  "F2_RW",
  "F3_LW",
  "F3_C",
  "F3_RW",
  "F4_LW",
  "F4_C",
  "F4_RW",
  "D1_L",
  "D1_R",
  "D2_L",
  "D2_R",
  "D3_L",
  "D3_R",
];

function emptyEntries(skaters) {
  const entries = {};
  skaters.forEach((p) => {
    entries[p.id] = { goals: 0, assists: 0 };
  });
  return entries;
}

// Builds the two-sided roster state (dressed skaters + dressed goalies),
// pre-filled from an existing box score when editing an already-scored game.
function buildSide(roster, storedSide) {
  const skaters = roster
    .filter((p) => p.position !== "G" && SLOT_ORDER.includes(p.lineupSlot))
    .sort((a, b) => SLOT_ORDER.indexOf(a.lineupSlot) - SLOT_ORDER.indexOf(b.lineupSlot));
  const goalies = roster.filter((p) => p.position === "G" && (p.lineupSlot === "G1" || p.lineupSlot === "G2"));

  const entries = emptyEntries(skaters);
  let goalieId = goalies.find((g) => g.lineupSlot === "G1")?.id ?? goalies[0]?.id ?? null;
  let shotsFaced = "";

  if (storedSide) {
    storedSide.skaters.forEach((s) => {
      if (entries[s.playerId]) entries[s.playerId] = { goals: s.goals, assists: s.assists };
    });
    if (storedSide.goalieId != null) goalieId = storedSide.goalieId;
    if (storedSide.shotsFaced != null) shotsFaced = String(storedSide.shotsFaced);
  }

  return { skaters, goalies, entries, goalieId, shotsFaced };
}

function TeamSide({ label, team, side, onChangeEntry, onChangeGoalie, onChangeShots }) {
  const totalGoals = Object.values(side.entries).reduce((sum, e) => sum + (Number(e.goals) || 0), 0);

  return (
    <div className="flex-1">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-slate-200">
          {label}: {team.city} {team.name}
        </h3>
        <span className="text-lg font-bold text-slate-100">{totalGoals}</span>
      </div>

      <div className="mb-4 rounded-lg bg-slate-800/60 p-3">
        <p className="mb-2 text-xs font-medium text-slate-400">Goalie</p>
        {side.goalies.length === 0 ? (
          <p className="text-xs text-amber-400">No goalie dressed (G1/G2) for this team.</p>
        ) : (
          <div className="mb-2 flex flex-wrap gap-3">
            {side.goalies.map((g) => (
              <label key={g.id} className="flex items-center gap-1.5 text-sm text-slate-200">
                <input
                  type="radio"
                  name={`goalie-${team.id}`}
                  checked={side.goalieId === g.id}
                  onChange={() => onChangeGoalie(g.id)}
                />
                {g.name} <span className="text-slate-500">({g.lineupSlot})</span>
              </label>
            ))}
          </div>
        )}
        <label className="flex items-center gap-2 text-xs text-slate-400">
          Shots faced
          <input
            type="number"
            min="0"
            required
            value={side.shotsFaced}
            onChange={(e) => onChangeShots(e.target.value)}
            className="w-20 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-center text-slate-100"
          />
        </label>
      </div>

      <div className="max-h-80 overflow-y-auto rounded-lg bg-slate-900">
        <div className="grid grid-cols-[1fr_3rem_3rem] gap-2 border-b border-slate-800 px-3 py-1.5 text-xs font-medium text-slate-500">
          <span>Player</span>
          <span className="text-center">G</span>
          <span className="text-center">A</span>
        </div>
        {side.skaters.map((p) => (
          <div
            key={p.id}
            className="grid grid-cols-[1fr_3rem_3rem] items-center gap-2 border-b border-slate-800 px-3 py-1 text-sm last:border-b-0"
          >
            <span className="truncate text-slate-200">
              {p.name} <span className="text-slate-500">({p.lineupSlot})</span>
            </span>
            <input
              type="number"
              min="0"
              value={side.entries[p.id]?.goals ?? 0}
              onChange={(e) => onChangeEntry(p.id, "goals", e.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-1 py-0.5 text-center text-slate-100"
            />
            <input
              type="number"
              min="0"
              value={side.entries[p.id]?.assists ?? 0}
              onChange={(e) => onChangeEntry(p.id, "assists", e.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-1 py-0.5 text-center text-slate-100"
            />
          </div>
        ))}
        {side.skaters.length === 0 && <p className="px-3 py-2 text-sm text-slate-600">No dressed skaters.</p>}
      </div>
    </div>
  );
}

export default function GameBoxScoreModal({ game, onClose, onSaved }) {
  const [rosters, setRosters] = useState(null);
  const [home, setHome] = useState(null);
  const [away, setAway] = useState(null);
  const [wentToOT, setWentToOT] = useState(false);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    Promise.all([api.getRoster(game.homeTeamId), api.getRoster(game.awayTeamId)])
      .then(([homeRes, awayRes]) => {
        setRosters({ home: homeRes.roster, away: awayRes.roster });
        setHome(buildSide(homeRes.roster, game.boxScore?.home));
        setAway(buildSide(awayRes.roster, game.boxScore?.away));
        setWentToOT(Boolean(game.boxScore?.wentToOT ?? game.wentToOT));
      })
      .catch((e) => setError(e.message));
  }, [game]);

  const homeGoals = useMemo(
    () => (home ? Object.values(home.entries).reduce((sum, e) => sum + (Number(e.goals) || 0), 0) : 0),
    [home]
  );
  const awayGoals = useMemo(
    () => (away ? Object.values(away.entries).reduce((sum, e) => sum + (Number(e.goals) || 0), 0) : 0),
    [away]
  );

  const updateEntry = (setter) => (playerId, field, value) => {
    setter((prev) => ({
      ...prev,
      entries: {
        ...prev.entries,
        [playerId]: { ...prev.entries[playerId], [field]: Math.max(0, Number(value) || 0) },
      },
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    if (homeGoals === awayGoals) {
      setError("The score can't end tied — check every goal is entered, including the OT winner.");
      return;
    }
    if (!home.goalieId || !away.goalieId) {
      setError("Both teams need a dressed goalie selected.");
      return;
    }

    setSubmitting(true);
    try {
      const toSidePayload = (side) => ({
        goalieId: side.goalieId,
        shotsFaced: Number(side.shotsFaced),
        // Every dressed skater is included, even 0G/0A — they still played the game.
        skaters: Object.entries(side.entries).map(([playerId, e]) => ({
          playerId: Number(playerId),
          goals: Number(e.goals) || 0,
          assists: Number(e.assists) || 0,
        })),
      });

      const updated = await api.submitScore(game.id, {
        wentToOT,
        home: toSidePayload(home),
        away: toSidePayload(away),
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
      <div className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-lg bg-slate-900 p-6">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-100">
              {game.awayTeam.abbr} @ {game.homeTeam.abbr} — Box Score
            </h2>
            <p className="text-xs text-slate-500">{game.date}</p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-slate-300">
            ✕
          </button>
        </div>

        {!home || !away ? (
          <p className="text-slate-400">Loading rosters…</p>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="mb-4 flex flex-col gap-6 sm:flex-row">
              <TeamSide
                label="Away"
                team={game.awayTeam}
                side={away}
                onChangeEntry={updateEntry(setAway)}
                onChangeGoalie={(id) => setAway((prev) => ({ ...prev, goalieId: id }))}
                onChangeShots={(v) => setAway((prev) => ({ ...prev, shotsFaced: v }))}
              />
              <TeamSide
                label="Home"
                team={game.homeTeam}
                side={home}
                onChangeEntry={updateEntry(setHome)}
                onChangeGoalie={(id) => setHome((prev) => ({ ...prev, goalieId: id }))}
                onChangeShots={(v) => setHome((prev) => ({ ...prev, shotsFaced: v }))}
              />
            </div>

            <div className="flex items-center gap-4 border-t border-slate-800 pt-4">
              <span className="text-sm text-slate-400">
                Final: <span className="font-semibold text-slate-100">{game.awayTeam.abbr} {awayGoals} – {homeGoals} {game.homeTeam.abbr}</span>
              </span>
              <label className="flex items-center gap-1.5 text-sm text-slate-400">
                <input type="checkbox" checked={wentToOT} onChange={(e) => setWentToOT(e.target.checked)} />
                Went to OT
              </label>
              <div className="ml-auto flex items-center gap-3">
                {error && <span className="text-sm text-red-400">{error}</span>}
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
                  {submitting ? "Saving…" : "Save Box Score"}
                </button>
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

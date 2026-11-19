import { useEffect, useState } from "react";
import { api } from "../api";
import GameScoreModal from "./GameScoreModal";
import PlayoffBracket from "./PlayoffBracket";

const teamName = (t) => `${t.city} ${t.name}`;

export default function CommissionerPlayoffs() {
  const [bracket, setBracket] = useState(null);
  const [teams, setTeams] = useState([]);
  const [standings, setStandings] = useState([]);
  const [seeds, setSeeds] = useState([]); // team ids as strings, index 0 = #1 seed
  const [scoreGame, setScoreGame] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);

  const loadBracket = (b) => {
    setBracket(b);
    setSeeds((prev) => (prev.length === b.fieldSize ? prev : Array(b.fieldSize).fill("")));
  };

  useEffect(() => {
    Promise.all([api.getPlayoffBracket(), api.getTeams(), api.getStandings()])
      .then(([b, t, s]) => {
        loadBracket(b);
        setTeams(t);
        setStandings(s);
      })
      .catch((e) => setError(e.message));
  }, []);

  const run = async (action, successMessage) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await action();
      // simulate-cpu wraps the bracket with a count; everything else returns it directly.
      const next = result.bracket ?? result;
      loadBracket(next);
      const msg = typeof successMessage === "function" ? successMessage(result) : successMessage;
      if (msg) setMessage(msg);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (error && !bracket) return <p className="text-red-500">{error}</p>;
  if (!bracket) return <p className="text-slate-400">Loading…</p>;

  const inPlayoffs = bracket.phase === "playoffs";
  const picked = new Set(seeds.filter(Boolean));
  const allPicked = seeds.length > 0 && seeds.every(Boolean);

  const setSeed = (index, value) => setSeeds((prev) => prev.map((v, i) => (i === index ? value : v)));
  const fillFromStandings = () => setSeeds(standings.slice(0, bracket.fieldSize).map((s) => String(s.teamId)));

  const handleStart = () =>
    run(() => api.setPlayoffField(seeds.map(Number)), `Bracket set — ${bracket.fieldSize} teams seeded.`);

  const handleReset = () => {
    if (
      !window.confirm(
        "Reset the playoffs? This deletes the bracket, every playoff game, and all playoff stats for this season."
      )
    ) {
      return;
    }
    run(() => api.resetPlayoffs(), "Playoffs reset.");
  };

  const renderGameAction = (game) => {
    if (!inPlayoffs) return null;
    if (game.gameType === "human_vs_human") {
      return (
        <button
          type="button"
          onClick={() => setScoreGame({ ...game, subtitle: `Game ${game.gameNumber}` })}
          className={
            game.status === "final"
              ? "shrink-0 text-xs font-medium text-slate-500 hover:text-sky-400"
              : "shrink-0 rounded-md bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-400 hover:bg-amber-500/25"
          }
        >
          {game.status === "final" ? "Edit" : "Enter Score"}
        </button>
      );
    }
    if (game.status === "scheduled") {
      return (
        <button
          type="button"
          disabled={busy}
          onClick={() => run(() => api.simulatePlayoffGame(game.id))}
          className="shrink-0 rounded-md bg-slate-800 px-2 py-0.5 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-50"
        >
          Sim
        </button>
      );
    }
    return null;
  };

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-slate-500">
        Pick the {bracket.fieldSize} playoff teams in seed order. Every series is best-of-{bracket.bestOf}. Games between
        two user teams are played on the console and scored here (final score only — their players' playoff stats go in
        the User Game Stats tab); any game with a CPU team is simulated. The final series crowns the champion
        automatically.
      </p>

      {!inPlayoffs && (
        <p className="rounded-lg bg-slate-900 px-4 py-3 text-sm text-amber-400">
          The league isn't in the Playoffs phase, so the field and games can't be changed right now.
        </p>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
      {message && <p className="text-sm text-emerald-400">{message}</p>}

      {bracket.champion && (
        <div className="rounded-lg bg-emerald-500/10 px-4 py-3 text-emerald-300">
          🏆 {teamName(bracket.champion)} — champions
        </div>
      )}

      {!bracket.started ? (
        <div className="rounded-lg bg-slate-900 p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-base font-semibold text-slate-100">Playoff Field</h3>
            <button
              type="button"
              onClick={fillFromStandings}
              className="rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
            >
              Fill from standings
            </button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {seeds.map((value, i) => (
              <label key={i} className="flex items-center gap-2 text-sm text-slate-400">
                <span className="w-14 shrink-0">Seed {i + 1}</span>
                <select
                  className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-slate-100"
                  value={value}
                  onChange={(e) => setSeed(i, e.target.value)}
                >
                  <option value="">Select team…</option>
                  {teams
                    .filter((t) => String(t.id) === value || !picked.has(String(t.id)))
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {teamName(t)}
                        {t.isHumanControlled ? " (user)" : ""}
                      </option>
                    ))}
                </select>
              </label>
            ))}
          </div>
          <button
            type="button"
            onClick={handleStart}
            disabled={busy || !allPicked || !inPlayoffs}
            className="mt-4 rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Start Bracket"}
          </button>
        </div>
      ) : (
        <>
          {inPlayoffs && (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() =>
                  run(
                    () => api.simulatePlayoffCpuGames(),
                    (r) =>
                      r.simmedCount > 0
                        ? `Simulated ${r.simmedCount} game${r.simmedCount === 1 ? "" : "s"}.`
                        : "No games with a CPU team are waiting."
                  )
                }
                disabled={busy}
                className="rounded-md bg-slate-800 px-3 py-1.5 text-sm font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-50"
              >
                {busy ? "Working…" : "Sim All CPU Games"}
              </button>
              <button
                type="button"
                onClick={handleReset}
                disabled={busy}
                className="ml-auto rounded-md px-3 py-1.5 text-sm text-red-400 hover:text-red-300 disabled:opacity-50"
              >
                Reset Playoffs
              </button>
            </div>
          )}
          <PlayoffBracket bracket={bracket} renderGameAction={renderGameAction} />
        </>
      )}

      {scoreGame && (
        <GameScoreModal
          game={scoreGame}
          submit={api.submitPlayoffScore}
          onClose={() => setScoreGame(null)}
          onSaved={(b) => {
            setScoreGame(null);
            loadBracket(b);
          }}
        />
      )}
    </div>
  );
}

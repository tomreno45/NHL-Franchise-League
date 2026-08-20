import { useEffect, useState } from "react";
import { api } from "../api";
import LeagueFlow from "./LeagueFlow";
import ManageUsers from "./ManageUsers";
import { seasonYearLabel } from "../seasonYear";

const ROSTER_STATUS_LABELS = {
  needs_update: "Needs Update",
  not_created: "Not Created",
};

export default function Commissioner() {
  const [phase, setPhase] = useState(null);
  const [season, setSeason] = useState(null);
  const [teams, setTeams] = useState([]);
  const [rosterChanges, setRosterChanges] = useState(null);
  const [playoffResults, setPlayoffResults] = useState(null);
  const [championId, setChampionId] = useState(null);
  const [error, setError] = useState(null);

  const [advanceDays, setAdvanceDays] = useState(3);
  const [advancing, setAdvancing] = useState(false);
  const [advanceMessage, setAdvanceMessage] = useState(null);

  const [simmingAll, setSimmingAll] = useState(false);
  const [simAllMessage, setSimAllMessage] = useState(null);

  const [crowning, setCrowning] = useState(false);
  const [crownMessage, setCrownMessage] = useState(null);

  const [draftOrder, setDraftOrderState] = useState(null);
  const [orderTeams, setOrderTeams] = useState(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const [orderMessage, setOrderMessage] = useState(null);

  const reloadSeason = () => api.getSeason().then(setSeason).catch((e) => setError(e.message));
  const reloadPhase = () => api.getLeaguePhase().then(setPhase).catch((e) => setError(e.message));
  const reloadRosterChanges = () => api.getRosterChanges().then(setRosterChanges).catch((e) => setError(e.message));
  const reloadPlayoffResults = () => api.getPlayoffResults().then(setPlayoffResults).catch((e) => setError(e.message));
  const reloadDraftOrder = () =>
    api
      .getDraftOrder()
      .then((d) => {
        setDraftOrderState(d);
        setOrderTeams(d.order.map((o) => o.team));
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    reloadSeason();
    reloadPhase();
    reloadRosterChanges();
    reloadPlayoffResults();
    reloadDraftOrder();
    api
      .getTeams()
      .then((t) => {
        setTeams(t);
        setChampionId(t[0]?.id ?? null);
      })
      .catch((e) => setError(e.message));
  }, []);

  const moveOrderTeam = (index, direction) => {
    const target = index + direction;
    if (target < 0 || target >= orderTeams.length) return;
    const next = orderTeams.slice();
    [next[index], next[target]] = [next[target], next[index]];
    setOrderTeams(next);
    setOrderMessage(null);
  };

  const handleSaveDraftOrder = async () => {
    setSavingOrder(true);
    setOrderMessage(null);
    setError(null);
    try {
      const result = await api.setDraftOrder(orderTeams.map((t) => t.id));
      setDraftOrderState(result);
      setOrderTeams(result.order.map((o) => o.team));
      setOrderMessage("Draft order saved.");
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingOrder(false);
    }
  };

  const handleAdvanceDate = async () => {
    setAdvancing(true);
    setAdvanceMessage(null);
    setError(null);
    try {
      const result = await api.advanceLeagueDate(Number(advanceDays));
      setAdvanceMessage(`League date is now ${result.leagueDate}. Simmed ${result.simmedCount} CPU-involved game(s).`);
      reloadSeason();
    } catch (e) {
      setError(e.message);
    } finally {
      setAdvancing(false);
    }
  };

  const handleSimAll = async () => {
    setSimmingAll(true);
    setSimAllMessage(null);
    setError(null);
    try {
      const result = await api.simulateAllRemainingGames();
      setSimAllMessage(`Simmed ${result.simmedCount} remaining CPU-involved game(s).`);
      reloadSeason();
    } catch (e) {
      setError(e.message);
    } finally {
      setSimmingAll(false);
    }
  };

  const handleCrown = async () => {
    setCrowning(true);
    setCrownMessage(null);
    setError(null);
    try {
      await api.setPlayoffChampion(championId);
      const team = teams.find((t) => t.id === championId);
      setCrownMessage(`${team.city} ${team.name} crowned champion.`);
      reloadPlayoffResults();
      reloadDraftOrder();
    } catch (e) {
      setError(e.message);
    } finally {
      setCrowning(false);
    }
  };

  if (error) return <p className="text-red-500">{error}</p>;
  if (!season || !phase || !rosterChanges || !playoffResults || championId == null) {
    return <p className="text-slate-400">Loading commissioner dashboard…</p>;
  }

  const pct = season.totalGames > 0 ? Math.round((season.gamesCompleted / season.totalGames) * 100) : 0;
  const totalRosterChanges = rosterChanges.reduce((sum, c) => sum + c.players.length, 0);

  return (
    <div className="flex flex-col gap-8">
      <LeagueFlow />

      <ManageUsers teams={teams} />

      <div className="rounded-lg bg-slate-900 p-5">
        <h2 className="mb-3 text-lg font-semibold text-slate-100">{seasonYearLabel(season.seasonNumber)} Season</h2>
        <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div>
            <div className="text-slate-500">League Date</div>
            <div className="text-slate-100">{season.leagueDate}</div>
          </div>
          <div>
            <div className="text-slate-500">Date Range</div>
            <div className="text-slate-100">
              {season.startDate} – {season.endDate}
            </div>
          </div>
          <div>
            <div className="text-slate-500">Games Played</div>
            <div className="text-slate-100">
              {season.gamesCompleted} / {season.totalGames}
            </div>
          </div>
          <div>
            <div className="text-slate-500">Remaining</div>
            <div className="text-slate-100">{season.gamesRemaining}</div>
          </div>
        </div>
        <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-slate-800">
          <div className="h-full rounded-full bg-sky-500" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="rounded-lg bg-slate-900 p-5">
        <h3 className="mb-1 text-base font-semibold text-slate-100">Advance League Date</h3>
        <p className="mb-3 text-sm text-slate-500">
          Moves the league's clock forward and auto-sims any CPU-involved games that become due.
        </p>
        <div className="flex items-center gap-3">
          <input
            type="number"
            min="1"
            value={advanceDays}
            onChange={(e) => setAdvanceDays(e.target.value)}
            className="w-20 rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-center text-slate-100"
          />
          <span className="text-sm text-slate-400">days</span>
          <button
            type="button"
            onClick={handleAdvanceDate}
            disabled={advancing}
            className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {advancing ? "Advancing…" : "Advance"}
          </button>
          {advanceMessage && <span className="text-sm text-emerald-400">{advanceMessage}</span>}
        </div>
      </div>

      <div className="rounded-lg bg-slate-900 p-5">
        <h3 className="mb-1 text-base font-semibold text-slate-100">Simulate Rest of Season</h3>
        <p className="mb-3 text-sm text-slate-500">
          Once every human-vs-human game has been played and scored in NHL 27, sim every remaining CPU-involved game
          regardless of date. Required before the season can advance to playoffs.
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleSimAll}
            disabled={simmingAll}
            className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {simmingAll ? "Simulating…" : "Simulate Rest of Season"}
          </button>
          {simAllMessage && <span className="text-sm text-emerald-400">{simAllMessage}</span>}
        </div>
      </div>

      {phase.phase === "roster_update" && (
        <div>
          <h3 className="mb-1 text-base font-semibold text-slate-100">Roster Update</h3>
          <p className="mb-4 text-sm text-slate-500">
            Apply these {totalRosterChanges} player card change{totalRosterChanges === 1 ? "" : "s"} in NHL 27 for
            each human team. Advancing the phase marks everything below as done and generates the season's schedule.
          </p>
          {rosterChanges.every((c) => c.players.length === 0) ? (
            <p className="text-sm text-slate-400">No pending changes — every human roster is up to date in NHL 27.</p>
          ) : (
            <div className="flex flex-col gap-4">
              {rosterChanges
                .filter((c) => c.players.length > 0)
                .map((c) => (
                  <div key={c.team.id} className="rounded-lg bg-slate-900 p-4">
                    <h4 className="mb-2 font-semibold text-slate-100">
                      {c.team.city} {c.team.name}
                    </h4>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-slate-500">
                          <th className="py-1 font-medium">Name</th>
                          <th className="py-1 font-medium">Pos</th>
                          <th className="py-1 text-right font-medium">OVR</th>
                          <th className="py-1 font-medium">Change</th>
                        </tr>
                      </thead>
                      <tbody>
                        {c.players.map((p) => (
                          <tr key={p.id} className="border-t border-slate-800">
                            <td className="py-1.5 text-slate-100">{p.name}</td>
                            <td className="py-1.5 text-slate-300">{p.position}</td>
                            <td className="py-1.5 text-right text-slate-300">{p.overall}</td>
                            <td className="py-1.5 text-amber-400">{ROSTER_STATUS_LABELS[p.inGameStatus]}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}

      {phase.phase === "playoffs" && (
        <div className="rounded-lg bg-slate-900 p-5">
          <h3 className="mb-1 text-base font-semibold text-slate-100">Select the Champion</h3>
          <p className="mb-3 text-sm text-slate-500">
            No bracket simulation yet — pick this season's winner directly. Required before the phase can advance.
          </p>
          <div className="flex items-center gap-3">
            <select
              className="rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-slate-100"
              value={championId}
              onChange={(e) => setChampionId(Number(e.target.value))}
            >
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.city} {t.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleCrown}
              disabled={crowning}
              className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            >
              {crowning ? "Saving…" : "Crown Champion"}
            </button>
            {crownMessage && <span className="text-sm text-emerald-400">{crownMessage}</span>}
          </div>
        </div>
      )}

      {["post_playoff_trade", "draft"].includes(phase.phase) && orderTeams && (
        <div className="rounded-lg bg-slate-900 p-5">
          <h3 className="mb-1 text-base font-semibold text-slate-100">Draft Order</h3>
          <p className="mb-3 text-sm text-slate-500">
            {draftOrder?.isCustom
              ? "Custom order saved below — adjust further to match how the real NHL 27 console playoffs actually went."
              : "Projected from standings, with the champion moved to last — this app doesn't simulate playoffs, so adjust below to match how the real NHL 27 console playoffs actually went."}{" "}
            Editable until the draft's first pick is made.
          </p>
          <ol className="flex flex-col gap-1.5">
            {orderTeams.map((t, i) => (
              <li
                key={t.id}
                className="flex items-center justify-between rounded-md bg-slate-950 px-3 py-1.5 text-sm"
              >
                <span className="text-slate-100">
                  <span className="mr-2 inline-block w-6 text-right text-slate-500">{i + 1}.</span>
                  {t.city} {t.name}
                </span>
                <span className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => moveOrderTeam(i, -1)}
                    disabled={i === 0}
                    className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => moveOrderTeam(i, 1)}
                    disabled={i === orderTeams.length - 1}
                    className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-30"
                  >
                    ↓
                  </button>
                </span>
              </li>
            ))}
          </ol>
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={handleSaveDraftOrder}
              disabled={savingOrder}
              className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            >
              {savingOrder ? "Saving…" : "Save Draft Order"}
            </button>
            {orderMessage && <span className="text-sm text-emerald-400">{orderMessage}</span>}
          </div>
        </div>
      )}

      <div>
        <h3 className="mb-2 text-sm font-semibold text-slate-300">Championship History</h3>
        {playoffResults.length === 0 ? (
          <p className="text-sm text-slate-500">No champions recorded yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg"><table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-800 text-left text-slate-400">
                <th className="px-3 py-2 font-medium">Season</th>
                <th className="px-3 py-2 font-medium">Champion</th>
              </tr>
            </thead>
            <tbody>
              {playoffResults.map((r, i) => (
                <tr key={r.seasonNumber} className={i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/50"}>
                  <td className="px-3 py-2 text-slate-300">{seasonYearLabel(r.seasonNumber)} Season</td>
                  <td className="px-3 py-2 text-slate-100">
                    {r.champion ? `${r.champion.city} ${r.champion.name}` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}

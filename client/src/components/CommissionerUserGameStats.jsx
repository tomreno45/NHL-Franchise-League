import { useEffect, useState } from "react";
import { api } from "../api";

const SKATER_FIELDS = [
  ["gamesPlayed", "GP"],
  ["goals", "G"],
  ["assists", "A"],
];
const GOALIE_FIELDS = [
  ["gamesPlayed", "GP"],
  ["wins", "W"],
  ["losses", "L"],
  ["otLosses", "OTL"],
  ["shutouts", "SO"],
  ["goalsAgainst", "GA"],
  ["shotsFaced", "Shots"],
];

const fieldsFor = (player) => (player.position === "G" ? GOALIE_FIELDS : SKATER_FIELDS);

// Inputs are kept as strings so a half-typed number doesn't fight the
// cursor; everything's converted when saved.
function draftsFrom(teams) {
  const drafts = {};
  teams.forEach((t) =>
    t.players.forEach((p) => {
      drafts[p.id] = Object.fromEntries(fieldsFor(p).map(([f]) => [f, String(p.consoleStats[f] ?? 0)]));
    })
  );
  return drafts;
}

const valueOf = (draft, field) => Number(draft?.[field] || 0);

function isDirty(player, draft) {
  return fieldsFor(player).some(([f]) => valueOf(draft, f) !== (player.consoleStats[f] ?? 0));
}

function NumberCell({ value, onChange, invalid }) {
  return (
    <input
      type="number"
      min="0"
      inputMode="numeric"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`w-14 rounded-md border bg-slate-950 px-1.5 py-1 text-right text-sm text-slate-100 ${
        invalid ? "border-red-500" : "border-slate-700"
      }`}
    />
  );
}

function PlayerTable({ players, fields, drafts, cap, onChange, extraHeader, extraCell }) {
  return (
    <div className="overflow-x-auto rounded-lg">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-slate-800 text-left text-slate-400">
            <th className="px-3 py-2 font-medium">Name</th>
            <th className="px-3 py-2 font-medium">Pos</th>
            {fields.map(([f, label]) => (
              <th key={f} className="px-2 py-2 text-right font-medium">
                {label}
              </th>
            ))}
            <th className="px-3 py-2 text-right font-medium">{extraHeader}</th>
          </tr>
        </thead>
        <tbody>
          {players.map((p, i) => {
            const draft = drafts[p.id];
            const overCap = valueOf(draft, "gamesPlayed") > cap;
            return (
              <tr key={p.id} className={i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/50"}>
                <td className="px-3 py-1.5 text-slate-100">
                  {p.name}
                  {p.lineupSlot === "MINORS" && <span className="ml-2 text-xs text-slate-500">(minors)</span>}
                </td>
                <td className="px-3 py-1.5 text-slate-300">{p.position}</td>
                {fields.map(([f]) => (
                  <td key={f} className="px-2 py-1.5 text-right">
                    <NumberCell
                      value={draft[f]}
                      onChange={(v) => onChange(p.id, f, v)}
                      invalid={f === "gamesPlayed" && overCap}
                    />
                  </td>
                ))}
                <td className="px-3 py-1.5 text-right text-slate-300">{extraCell(draft)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function CommissionerUserGameStats() {
  const [teams, setTeams] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [error, setError] = useState(null);
  const [savingTeamId, setSavingTeamId] = useState(null);
  const [message, setMessage] = useState(null);

  const load = (data) => {
    setTeams(data);
    setDrafts(draftsFrom(data));
  };

  useEffect(() => {
    api.getUserGameStats().then(load).catch((e) => setError(e.message));
  }, []);

  const handleChange = (playerId, field, value) => {
    setMessage(null);
    setDrafts((prev) => ({ ...prev, [playerId]: { ...prev[playerId], [field]: value } }));
  };

  const handleSave = async (team) => {
    setError(null);
    setMessage(null);
    const dirty = team.players.filter((p) => isDirty(p, drafts[p.id]));
    const entries = dirty.map((p) => ({
      playerId: p.id,
      ...Object.fromEntries(fieldsFor(p).map(([f]) => [f, valueOf(drafts[p.id], f)])),
    }));
    if (entries.some((e) => Object.values(e).some((v) => !Number.isInteger(v)))) {
      setError("Every stat needs to be a whole number.");
      return;
    }

    setSavingTeamId(team.team.id);
    try {
      load(await api.saveUserGameStats(entries));
      setMessage(`Saved ${entries.length} player${entries.length === 1 ? "" : "s"} for ${team.team.city} ${team.team.name}.`);
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingTeamId(null);
    }
  };

  if (!teams) return error ? <p className="text-red-500">{error}</p> : <p className="text-slate-400">Loading…</p>;

  return (
    <div>
      <p className="mb-4 text-sm text-slate-500">
        Console games only record a final score, so each user team's player stats from those games go in here as
        season-to-date totals — re-entering replaces the last numbers. Games played can't be more than the user games
        scored for that team. Stats from games against CPU teams come from the simulation and aren't touched.
      </p>
      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
      {message && <p className="mb-3 text-sm text-emerald-400">{message}</p>}

      <div className="flex flex-col gap-6">
        {teams.map((t) => {
          const skaters = t.players.filter((p) => p.position !== "G");
          const goalies = t.players.filter((p) => p.position === "G");
          const dirtyCount = t.players.filter((p) => isDirty(p, drafts[p.id])).length;
          const enteredGoals = skaters.reduce((sum, p) => sum + valueOf(drafts[p.id], "goals"), 0);
          const overCap = t.players.some((p) => valueOf(drafts[p.id], "gamesPlayed") > t.userGamesPlayed);

          return (
            <div key={t.team.id} className="rounded-lg bg-slate-900 p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-slate-100">
                    {t.team.city} {t.team.name}
                  </h3>
                  <p className="text-xs text-slate-500">
                    {t.userGamesPlayed} user game{t.userGamesPlayed === 1 ? "" : "s"} scored · {t.goalsFor} goals for in
                    them · {enteredGoals} skater goals entered
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleSave(t)}
                  disabled={savingTeamId === t.team.id || dirtyCount === 0 || overCap}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                >
                  {savingTeamId === t.team.id ? "Saving…" : `Save Changes (${dirtyCount})`}
                </button>
              </div>

              {t.userGamesPlayed === 0 ? (
                <p className="text-sm text-slate-500">
                  No user games scored for this team yet — enter their scores on the Schedule tab first.
                </p>
              ) : (
                <div className="flex flex-col gap-4">
                  <PlayerTable
                    players={skaters}
                    fields={SKATER_FIELDS}
                    drafts={drafts}
                    cap={t.userGamesPlayed}
                    onChange={handleChange}
                    extraHeader="P"
                    extraCell={(d) => valueOf(d, "goals") + valueOf(d, "assists")}
                  />
                  {goalies.length > 0 && (
                    <PlayerTable
                      players={goalies}
                      fields={GOALIE_FIELDS}
                      drafts={drafts}
                      cap={t.userGamesPlayed}
                      onChange={handleChange}
                      extraHeader="SV%"
                      extraCell={(d) =>
                        valueOf(d, "shotsFaced") > 0
                          ? (1 - valueOf(d, "goalsAgainst") / valueOf(d, "shotsFaced")).toFixed(3)
                          : "—"
                      }
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

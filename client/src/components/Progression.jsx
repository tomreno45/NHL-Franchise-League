import { useEffect, useState } from "react";
import { api } from "../api";

// Mirrors server/data.js's ATTRIBUTE_CATEGORIES so the (now 25) attribute
// deltas read as grouped sections instead of one long wall of chips.
const SKATER_GROUPS = [
  { label: "Puck Skills", attrs: [["deking", "DEK"], ["handEye", "H-E"], ["passing", "PAS"], ["puckControl", "PC"]] },
  { label: "Senses", attrs: [["discipline", "DIS"], ["offAwareness", "OFA"], ["poise", "POI"]] },
  {
    label: "Shooting",
    attrs: [["slapShotAccuracy", "SSA"], ["slapShotPower", "SSP"], ["wristShotAccuracy", "WSA"], ["wristShotPower", "WSP"]],
  },
  { label: "Defense", attrs: [["defAwareness", "DEF"], ["faceoffs", "FO"], ["shotBlocking", "SB"], ["stickChecking", "STK"]] },
  { label: "Skating", attrs: [["acceleration", "ACC"], ["agility", "AGI"], ["balance", "BAL"], ["endurance", "END"], ["speed", "SPD"]] },
  {
    label: "Physical",
    attrs: [["aggressiveness", "AGG"], ["bodyChecking", "BC"], ["durability", "DUR"], ["fightingSkill", "FS"], ["strength", "STR"]],
  },
];

// Mirrors server/data.js's GOALIE_ATTRIBUTE_CATEGORIES.
const GOALIE_GROUPS = [
  { label: "Low", attrs: [["gloveLow", "GLV-L"], ["stickLow", "STK-L"], ["fiveHole", "5-HOLE"]] },
  { label: "Hands", attrs: [["gloveHigh", "GLV-H"], ["stickHigh", "STK-H"], ["passing", "PAS"]] },
  {
    label: "Quickness",
    attrs: [["speed", "SPD"], ["agility", "AGI"], ["pokeCheck", "POKE"], ["durability", "DUR"], ["endurance", "END"]],
  },
  {
    label: "Positioning",
    attrs: [["reboundControl", "REB"], ["vision", "VIS"], ["breakaway", "BRK"], ["angles", "ANG"], ["recover", "REC"]],
  },
];

function DeltaBadge({ value }) {
  const sign = value > 0 ? "+" : "";
  const color =
    value > 0 ? "text-emerald-400" : value < 0 ? "text-red-400" : "text-slate-500";
  return <span className={`font-semibold ${color}`}>{sign}{value}</span>;
}

function chip(attr, label, delta) {
  return (
    <span
      key={attr}
      className={`rounded px-1.5 py-0.5 text-xs ${
        delta > 0
          ? "bg-emerald-500/15 text-emerald-400"
          : delta < 0
            ? "bg-red-500/15 text-red-400"
            : "bg-slate-800 text-slate-500"
      }`}
    >
      {label} {delta > 0 ? "+" : ""}
      {delta}
    </span>
  );
}

function AttributeChips({ attributeDeltas, position }) {
  if (!attributeDeltas) return null;
  const groups = position === "G" ? GOALIE_GROUPS : SKATER_GROUPS;
  return (
    <div className="flex flex-col gap-1">
      {groups.map((group) => {
        const present = group.attrs.filter(([attr]) => attr in attributeDeltas);
        if (present.length === 0) return null;
        return (
          <div key={group.label} className="flex flex-wrap items-center gap-1.5">
            <span className="w-20 shrink-0 text-xs text-slate-500">{group.label}</span>
            {present.map(([attr, label]) => chip(attr, label, attributeDeltas[attr]))}
          </div>
        );
      })}
    </div>
  );
}

export default function Progression() {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    api
      .getLatestProgression()
      .then(setResult)
      .catch(() => {});
  }, []);

  const handleRun = async () => {
    setLoading(true);
    setError(null);
    setConfirming(false);
    try {
      const data = await api.runProgression();
      setResult(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <a
          href={api.exportNeedsUpdateUrl}
          className="rounded-md bg-slate-800 px-3 py-1.5 text-sm font-medium text-slate-100 hover:bg-slate-700"
        >
          Download Needs-Update Excel
        </a>
        <a
          href={api.exportNotCreatedUrl}
          className="rounded-md bg-slate-800 px-3 py-1.5 text-sm font-medium text-slate-100 hover:bg-slate-700"
        >
          Download Needs-Creation Excel
        </a>
      </div>
      <p className="mb-6 text-xs text-slate-500">
        Every human team's players who need an existing NHL 27 player edited, or who don't exist in NHL 27 yet and
        need to be created — full attribute values included so there's no need to look each one up individually.
      </p>

      <div className="mb-6 flex items-center gap-3">
        {confirming ? (
          <>
            <span className="text-sm text-amber-400">
              This ages every player, applies rating changes, and resets season stats. Continue?
            </span>
            <button
              type="button"
              onClick={handleRun}
              disabled={loading}
              className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50"
            >
              {loading ? "Running…" : "Confirm"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-md px-3 py-1.5 text-sm text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500"
          >
            Run Offseason Progression
          </button>
        )}
        {error && <span className="text-sm text-red-400">{error}</span>}
      </div>

      <p className="mb-4 text-xs text-slate-500">
        Note: progression also runs automatically when the commissioner advances past the "Progression" phase in the
        season flow — use this button for a manual/off-cycle run, not both back to back.
      </p>

      {!result ? (
        <p className="text-slate-400">
          Progression hasn't been run yet this session. Running it ages every player one year,
          applies age-curve and performance-based rating changes, and flags anyone who moved ≥2
          OVR for their GM to update in-game.
        </p>
      ) : (
        <div>
          <p className="mb-4 text-sm text-slate-500">
            Last run {new Date(result.generatedAt).toLocaleString()} — {result.totalPlayersProgressed}{" "}
            players progressed, {result.totalFlagged} flagged league-wide.
          </p>
          <div className="grid gap-6 md:grid-cols-2">
            {result.changeSheets.map((sheet) => (
              <div key={sheet.teamId}>
                <h2 className="mb-2 text-lg font-semibold text-slate-100">
                  {sheet.city} {sheet.name}
                  <span className="ml-2 text-sm font-normal text-slate-500">
                    {sheet.players.length} change{sheet.players.length === 1 ? "" : "s"}
                  </span>
                </h2>
                {sheet.players.length === 0 ? (
                  <p className="text-sm text-slate-500">No players moved ≥2 OVR.</p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {sheet.players.map((p) => (
                      <div key={p.playerId} className="rounded-lg bg-slate-900 px-4 py-2.5 text-sm">
                        <div className="mb-1 flex items-center justify-between">
                          <span className="text-slate-100">
                            {p.name}{" "}
                            <span className="text-slate-500">
                              ({p.position}, age {p.previousAge} → {p.newAge})
                            </span>
                          </span>
                          <span className="text-slate-300">
                            {p.previousOverall} → {p.newOverall}{" "}
                            <DeltaBadge value={p.ovrDelta} />
                          </span>
                        </div>
                        <AttributeChips attributeDeltas={p.attributeDeltas} position={p.position} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

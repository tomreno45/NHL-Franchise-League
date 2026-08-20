import { Fragment, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import StarRating, { CONFIDENCE_COLORS } from "./StarRating";
import PlayerAttributes from "./PlayerAttributes";
import TradeValueBar from "./TradeValueBar";
import SortableHeader from "./SortableHeader";
import CapBar from "./CapBar";
import TeamLogo from "./TeamLogo";
import { sortRows } from "../sortUtils";

const ROSTER_ACCESSORS = {
  jerseyNumber: (p) => p.jerseyNumber,
  name: (p) => p.name,
  position: (p) => p.position,
  age: (p) => p.age,
  overall: (p) => p.overall,
  potential: (p) => p.potential.stars,
  tradeValue: (p) => p.tradeValue,
  capHit: (p) => p.capHit,
  contractYearsLeft: (p) => p.contractYearsLeft,
  inGameStatus: (p) => p.inGameStatus,
};

const STATUS_STYLES = {
  active: "bg-emerald-500/15 text-emerald-400",
  needs_update: "bg-amber-500/15 text-amber-400",
  not_created: "bg-slate-500/15 text-slate-400",
};

const STATUS_LABELS = {
  active: "Active",
  needs_update: "Needs Update",
  not_created: "Not Created",
};

function StatBlock({ label, value }) {
  return (
    <div>
      <div className="hub-label">{label}</div>
      <div className="text-lg font-bold text-slate-100">{value}</div>
    </div>
  );
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Shared by My Team > Roster (scoped to the viewer's own team) and
// League > Rosters (any team, via a selector) — same table, sorting, and
// expandable player-detail behavior either way.
export default function RosterTable({ teamId }) {
  const [roster, setRoster] = useState(null);
  const [standings, setStandings] = useState(null);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [sort, setSort] = useState({ key: null, dir: "desc" });

  useEffect(() => {
    if (teamId == null) return;
    setExpandedId(null);
    setRoster(null);
    api
      .getRoster(teamId)
      .then((data) => setRoster(data))
      .catch((e) => setError(e.message));
  }, [teamId]);

  useEffect(() => {
    api.getStandings().then(setStandings).catch((e) => setError(e.message));
  }, []);

  const handleSort = (key) => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));
  };

  const sortedRoster = useMemo(() => {
    if (!roster) return null;
    return sortRows(roster.roster, ROSTER_ACCESSORS, sort.key, sort.dir);
  }, [roster, sort]);

  if (error) return <p className="text-red-500">{error}</p>;

  const standing = standings?.find((s) => s.teamId === teamId);
  const leagueRank = standings ? [...standings].sort((a, b) => b.points - a.points).findIndex((s) => s.teamId === teamId) + 1 : null;
  const teamOverall = roster ? Math.round(roster.roster.reduce((sum, p) => sum + p.overall, 0) / roster.roster.length) : null;
  const dressedSkaters = roster ? roster.roster.filter((p) => /^(F|D)\d/.test(p.lineupSlot || "")).length : 0;
  const dressedGoalies = roster ? roster.roster.filter((p) => p.lineupSlot === "G1" || p.lineupSlot === "G2").length : 0;

  return (
    <div>
      {!roster ? (
        <p className="text-slate-400">Loading roster…</p>
      ) : (
        <>
          <div className="hub-card mb-5 rounded-xl p-5">
            <div className="flex flex-wrap items-start justify-between gap-6">
              <div className="flex items-center gap-4">
                <TeamLogo abbr={roster.team.abbr} size={56} />
                <div>
                  <h2 className="text-2xl font-bold leading-tight text-slate-100">
                    {roster.team.city} {roster.team.name}
                  </h2>
                  <div className="mt-1">
                    <CapBar {...roster.capSummary} />
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-x-8 gap-y-3 sm:grid-cols-5">
                <StatBlock label="Season Record" value={standing ? `${standing.wins}-${standing.losses}-${standing.otLosses}` : "—"} />
                <StatBlock label="League Rank" value={leagueRank ? ordinal(leagueRank) : "—"} />
                <StatBlock label="Team OVR" value={teamOverall ?? "—"} />
                <StatBlock label="Dressed Skaters" value={`${dressedSkaters}/18`} />
                <StatBlock label="Dressed Goalies" value={`${dressedGoalies}/2`} />
              </div>
            </div>
          </div>

          <div className="hub-card overflow-x-auto rounded-xl">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/5 text-left text-slate-400">
                  <SortableHeader label="#" sortKey="jerseyNumber" currentKey={sort.key} direction={sort.dir} onSort={handleSort} />
                  <SortableHeader label="Name" sortKey="name" currentKey={sort.key} direction={sort.dir} onSort={handleSort} />
                  <SortableHeader label="Pos" sortKey="position" currentKey={sort.key} direction={sort.dir} onSort={handleSort} />
                  <SortableHeader label="Age" sortKey="age" currentKey={sort.key} direction={sort.dir} onSort={handleSort} align="right" />
                  <SortableHeader label="OVR" sortKey="overall" currentKey={sort.key} direction={sort.dir} onSort={handleSort} align="right" />
                  <SortableHeader label="Potential" sortKey="potential" currentKey={sort.key} direction={sort.dir} onSort={handleSort} />
                  <SortableHeader label="Trade Value" sortKey="tradeValue" currentKey={sort.key} direction={sort.dir} onSort={handleSort} />
                  <SortableHeader label="Cap Hit" sortKey="capHit" currentKey={sort.key} direction={sort.dir} onSort={handleSort} align="right" />
                  <SortableHeader label="Yrs Left" sortKey="contractYearsLeft" currentKey={sort.key} direction={sort.dir} onSort={handleSort} align="right" />
                  <SortableHeader label="In-Game Status" sortKey="inGameStatus" currentKey={sort.key} direction={sort.dir} onSort={handleSort} />
                </tr>
              </thead>
              <tbody>
                {sortedRoster.map((p, i) => (
                  <Fragment key={p.id}>
                    <tr
                      onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}
                      className={`cursor-pointer border-b border-white/5 last:border-0 ${
                        i % 2 === 0 ? "bg-white/[0.02]" : ""
                      } ${expandedId === p.id ? "outline outline-1 -outline-offset-1 outline-cyan-400/40" : ""} hover:bg-white/5`}
                    >
                      <td className="px-3 py-2 text-slate-400">{p.jerseyNumber}</td>
                      <td className="px-3 py-2 text-slate-100">{p.name}</td>
                      <td className="px-3 py-2 text-slate-300">{p.position}</td>
                      <td className="px-3 py-2 text-right text-slate-300">{p.age}</td>
                      <td className="px-3 py-2 text-right font-semibold text-slate-100">{p.overall}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <StarRating value={p.potential.stars} colorClass={CONFIDENCE_COLORS[p.potential.confidence]} />
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <TradeValueBar value={p.tradeValue} />
                      </td>
                      <td className="px-3 py-2 text-right text-slate-300">${p.capHit.toFixed(2)}M</td>
                      <td className="px-3 py-2 text-right text-slate-300">{p.contractYearsLeft}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[p.inGameStatus]}`}
                        >
                          {STATUS_LABELS[p.inGameStatus]}
                        </span>
                      </td>
                    </tr>
                    {expandedId === p.id && (
                      <tr className="border-b border-white/5 bg-black/20 last:border-0">
                        <td colSpan={10} className="px-6 py-4">
                          <PlayerAttributes player={p} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

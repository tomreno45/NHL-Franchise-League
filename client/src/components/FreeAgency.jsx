import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useMyTeam } from "../MyTeamContext";
import { PHASE_LABELS } from "../phaseLabels";
import { sortRows } from "../sortUtils";
import StarRating, { CONFIDENCE_COLORS } from "./StarRating";
import SortableHeader from "./SortableHeader";
import CapBar from "./CapBar";

const PLAYER_ACCESSORS = {
  name: (p) => p.name,
  position: (p) => p.position,
  age: (p) => p.age,
  overall: (p) => p.overall,
  potential: (p) => p.potential.stars,
  asking: (p) => p.contractDemand.aavMillions,
};

const EXPIRING_ACCESSORS = { ...PLAYER_ACCESSORS, team: (p) => p.team.abbr };

function useSort(initialKey = null) {
  const [sort, setSort] = useState({ key: initialKey, dir: "desc" });
  const onSort = (key) => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));
  };
  return [sort, onSort];
}

function BidRow({ player, onBid }) {
  const [aav, setAav] = useState(player.contractDemand.aavMillions.toFixed(3));
  const [years, setYears] = useState(player.contractDemand.yearsRequested);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const myBid = player.yourBid;

  const submit = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await onBid({ playerId: player.id, aavMillions: Number(aav), years: Number(years) });
      setMessage("Bid submitted");
    } catch (e) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr className="border-b border-slate-800 last:border-0">
      <td className="px-3 py-2 text-slate-100">{player.name}</td>
      <td className="px-3 py-2 text-slate-300">{player.position}</td>
      <td className="px-3 py-2 text-right text-slate-300">{player.age}</td>
      <td className="px-3 py-2 text-right font-semibold text-slate-100">{player.overall}</td>
      <td className="px-3 py-2">
        <StarRating value={player.potential.stars} colorClass={CONFIDENCE_COLORS[player.potential.confidence]} />
      </td>
      <td className="px-3 py-2 text-right text-slate-300">
        ${player.contractDemand.aavMillions.toFixed(3)}M / {player.contractDemand.yearsRequested}yr
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            step="0.025"
            min="0.925"
            value={aav}
            onChange={(e) => setAav(e.target.value)}
            className="w-20 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-right text-slate-100"
          />
          <span className="text-xs text-slate-500">M ×</span>
          <input
            type="number"
            min="1"
            max="8"
            value={years}
            onChange={(e) => setYears(e.target.value)}
            className="w-14 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-right text-slate-100"
          />
          <span className="text-xs text-slate-500">yr</span>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="rounded-md bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {myBid ? "Revise" : "Bid"}
          </button>
        </div>
        {message && <div className="mt-1 text-xs text-slate-400">{message}</div>}
      </td>
    </tr>
  );
}

function ReadOnlyPlayerRow({ player, extraCell }) {
  return (
    <tr className="border-b border-slate-800 last:border-0">
      <td className="px-3 py-2 text-slate-100">{player.name}</td>
      {extraCell}
      <td className="px-3 py-2 text-slate-300">{player.position}</td>
      <td className="px-3 py-2 text-right text-slate-300">{player.age}</td>
      <td className="px-3 py-2 text-right font-semibold text-slate-100">{player.overall}</td>
      <td className="px-3 py-2">
        <StarRating value={player.potential.stars} colorClass={CONFIDENCE_COLORS[player.potential.confidence]} />
      </td>
      <td className="px-3 py-2 text-right text-slate-300">
        ${player.contractDemand.aavMillions.toFixed(3)}M / {player.contractDemand.yearsRequested}yr
      </td>
    </tr>
  );
}

export default function FreeAgency() {
  const { myTeamId } = useMyTeam();
  const [board, setBoard] = useState(null);
  const [capSummary, setCapSummary] = useState(null);
  const [error, setError] = useState(null);
  const [faSort, onFaSort] = useSort();
  const [expiringSort, onExpiringSort] = useSort();

  const reload = () => {
    if (myTeamId == null) return;
    api.getFreeAgencyBoard(myTeamId).then(setBoard).catch((e) => setError(e.message));
    api.getTeamCap(myTeamId).then(setCapSummary).catch((e) => setError(e.message));
  };

  useEffect(reload, [myTeamId]);

  const handleBid = async ({ playerId, aavMillions, years }) => {
    await api.submitFreeAgentBid({ teamId: myTeamId, playerId, aavMillions, years });
    reload();
  };

  const sortedFreeAgents = useMemo(
    () => (board ? sortRows(board.freeAgents, PLAYER_ACCESSORS, faSort.key, faSort.dir) : []),
    [board, faSort]
  );
  const sortedExpiring = useMemo(
    () => (board ? sortRows(board.expiringSoon, EXPIRING_ACCESSORS, expiringSort.key, expiringSort.dir) : []),
    [board, expiringSort]
  );

  if (error) return <p className="text-red-500">{error}</p>;
  if (myTeamId == null || !board) return <p className="text-slate-400">Loading free agency board…</p>;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm text-slate-500">
            {board.biddingOpen
              ? `Round ${board.round} — ${board.freeAgents.length} free agent${board.freeAgents.length === 1 ? "" : "s"}`
              : `${board.freeAgents.length} free agent${board.freeAgents.length === 1 ? "" : "s"} on the market — bidding opens during Free Agency or the Trade Period`}
          </span>
          {capSummary && <CapBar {...capSummary} />}
        </div>

        {!board.biddingOpen && board.freeAgents.length > 0 && (
          <p className="mb-3 text-sm text-amber-400">
            Not available during {PHASE_LABELS[board.phase] || board.phase} — showing the current pool only.
          </p>
        )}

        {board.freeAgents.length === 0 ? (
          <p className="text-slate-400">No free agents on the market right now.</p>
        ) : board.biddingOpen ? (
          <div className="overflow-x-auto rounded-lg"><table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-800 text-left text-slate-400">
                <SortableHeader label="Name" sortKey="name" currentKey={faSort.key} direction={faSort.dir} onSort={onFaSort} />
                <SortableHeader label="Pos" sortKey="position" currentKey={faSort.key} direction={faSort.dir} onSort={onFaSort} />
                <SortableHeader label="Age" sortKey="age" currentKey={faSort.key} direction={faSort.dir} onSort={onFaSort} align="right" />
                <SortableHeader label="OVR" sortKey="overall" currentKey={faSort.key} direction={faSort.dir} onSort={onFaSort} align="right" />
                <SortableHeader label="Potential" sortKey="potential" currentKey={faSort.key} direction={faSort.dir} onSort={onFaSort} />
                <SortableHeader label="Asking" sortKey="asking" currentKey={faSort.key} direction={faSort.dir} onSort={onFaSort} align="right" />
                <th className="px-3 py-2 font-medium">Your Bid</th>
              </tr>
            </thead>
            <tbody>
              {sortedFreeAgents.map((p) => (
                <BidRow key={p.id} player={p} onBid={handleBid} />
              ))}
            </tbody>
          </table>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg"><table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-800 text-left text-slate-400">
                <SortableHeader label="Name" sortKey="name" currentKey={faSort.key} direction={faSort.dir} onSort={onFaSort} />
                <SortableHeader label="Pos" sortKey="position" currentKey={faSort.key} direction={faSort.dir} onSort={onFaSort} />
                <SortableHeader label="Age" sortKey="age" currentKey={faSort.key} direction={faSort.dir} onSort={onFaSort} align="right" />
                <SortableHeader label="OVR" sortKey="overall" currentKey={faSort.key} direction={faSort.dir} onSort={onFaSort} align="right" />
                <SortableHeader label="Potential" sortKey="potential" currentKey={faSort.key} direction={faSort.dir} onSort={onFaSort} />
                <SortableHeader label="Asking" sortKey="asking" currentKey={faSort.key} direction={faSort.dir} onSort={onFaSort} align="right" />
              </tr>
            </thead>
            <tbody>
              {sortedFreeAgents.map((p) => (
                <ReadOnlyPlayerRow key={p.id} player={p} />
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-slate-300">Expiring Soon</h3>
        <p className="mb-3 text-xs text-slate-500">
          Contracts due to lapse across the league — a preview only, since each player's own team can still
          re-sign them before they'd hit the open market.
        </p>
        {board.expiringSoon.length === 0 ? (
          <p className="text-slate-400">No contracts are expiring soon.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg"><table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-800 text-left text-slate-400">
                <SortableHeader label="Name" sortKey="name" currentKey={expiringSort.key} direction={expiringSort.dir} onSort={onExpiringSort} />
                <SortableHeader label="Team" sortKey="team" currentKey={expiringSort.key} direction={expiringSort.dir} onSort={onExpiringSort} />
                <SortableHeader label="Pos" sortKey="position" currentKey={expiringSort.key} direction={expiringSort.dir} onSort={onExpiringSort} />
                <SortableHeader label="Age" sortKey="age" currentKey={expiringSort.key} direction={expiringSort.dir} onSort={onExpiringSort} align="right" />
                <SortableHeader label="OVR" sortKey="overall" currentKey={expiringSort.key} direction={expiringSort.dir} onSort={onExpiringSort} align="right" />
                <SortableHeader label="Potential" sortKey="potential" currentKey={expiringSort.key} direction={expiringSort.dir} onSort={onExpiringSort} />
                <SortableHeader label="Asking" sortKey="asking" currentKey={expiringSort.key} direction={expiringSort.dir} onSort={onExpiringSort} align="right" />
              </tr>
            </thead>
            <tbody>
              {sortedExpiring.map((p) => (
                <ReadOnlyPlayerRow
                  key={p.id}
                  player={p}
                  extraCell={<td className="px-3 py-2 text-slate-300">{p.team.abbr}</td>}
                />
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}

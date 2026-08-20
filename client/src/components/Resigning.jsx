import { useEffect, useState } from "react";
import { api } from "../api";
import { useMyTeam } from "../MyTeamContext";
import { PHASE_LABELS } from "../phaseLabels";
import StarRating, { CONFIDENCE_COLORS } from "./StarRating";
import CapBar from "./CapBar";

function OfferRow({ player, teamId, onOffer }) {
  const [aav, setAav] = useState(player.contractDemand.aavMillions.toFixed(3));
  const [years, setYears] = useState(player.contractDemand.yearsRequested);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const submit = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await onOffer({ playerId: player.id, aavMillions: Number(aav), years: Number(years) });
      setMessage("Offer submitted");
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
      <td className="px-3 py-2 text-slate-400">
        {player.currentOffer ? (
          <span className="text-sky-400">
            ${player.currentOffer.aavMillions.toFixed(3)}M / {player.currentOffer.years}yr offered
          </span>
        ) : (
          <span className="text-slate-600">No offer yet</span>
        )}
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
            {player.currentOffer ? "Revise" : "Offer"}
          </button>
        </div>
        {message && <div className="mt-1 text-xs text-slate-400">{message}</div>}
      </td>
    </tr>
  );
}

function ReadOnlyRow({ player }) {
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
    </tr>
  );
}

export default function Resigning() {
  const { myTeamId, teams } = useMyTeam();
  const [board, setBoard] = useState(null);
  const [capSummary, setCapSummary] = useState(null);
  const [error, setError] = useState(null);

  const reload = () => {
    api.getResigningBoard().then(setBoard).catch((e) => setError(e.message));
    if (myTeamId != null) api.getTeamCap(myTeamId).then(setCapSummary).catch((e) => setError(e.message));
  };

  useEffect(reload, [myTeamId]);

  const handleOffer = async ({ playerId, aavMillions, years }) => {
    await api.submitResignOffer({ teamId: myTeamId, playerId, aavMillions, years });
    reload();
  };

  if (error) return <p className="text-red-500">{error}</p>;
  if (myTeamId == null || !board) return <p className="text-slate-400">Loading re-signing board…</p>;

  const myTeam = teams.find((t) => t.id === myTeamId);
  const myPending = board.players.filter((p) => p.team.id === myTeamId);
  const resigningOpen = board.resigningOpen;

  return (
    <div>
      <div className="mb-4">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-slate-100">{myTeam ? `${myTeam.city} ${myTeam.name}` : ""}</h2>
          {capSummary && <CapBar {...capSummary} />}
        </div>
        <span className="text-sm text-slate-500">
          {resigningOpen
            ? `Round ${board.round} — exclusive negotiation with your own pending free agents. Unsigned players hit the open market next season.`
            : "Expiring contracts on your roster. Offers open during the Re-signing phase."}
        </span>
      </div>

      {!resigningOpen && myPending.length > 0 && (
        <p className="mb-3 text-sm text-amber-400">
          Not available during {PHASE_LABELS[board.phase] || board.phase} — showing expiring contracts only.
        </p>
      )}

      {myPending.length === 0 ? (
        <p className="text-slate-400">No expiring contracts on this roster right now.</p>
      ) : resigningOpen ? (
        <div className="overflow-x-auto rounded-lg"><table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-800 text-left text-slate-400">
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Pos</th>
              <th className="px-3 py-2 text-right font-medium">Age</th>
              <th className="px-3 py-2 text-right font-medium">OVR</th>
              <th className="px-3 py-2 font-medium">Potential</th>
              <th className="px-3 py-2 text-right font-medium">Asking</th>
              <th className="px-3 py-2 font-medium">Current Offer</th>
              <th className="px-3 py-2 font-medium">Your Offer</th>
            </tr>
          </thead>
          <tbody>
            {myPending.map((p) => (
              <OfferRow key={p.id} player={p} teamId={myTeamId} onOffer={handleOffer} />
            ))}
          </tbody>
        </table>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg"><table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-800 text-left text-slate-400">
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Pos</th>
              <th className="px-3 py-2 text-right font-medium">Age</th>
              <th className="px-3 py-2 text-right font-medium">OVR</th>
              <th className="px-3 py-2 font-medium">Potential</th>
              <th className="px-3 py-2 text-right font-medium">Asking</th>
            </tr>
          </thead>
          <tbody>
            {myPending.map((p) => (
              <ReadOnlyRow key={p.id} player={p} />
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { api } from "../api";
import { useMyTeam } from "../MyTeamContext";
import { draftYear } from "../seasonYear";
import TradeValueBar from "./TradeValueBar";

const STATUS_STYLES = {
  pending: "bg-slate-500/15 text-slate-400",
  executed: "bg-emerald-500/15 text-emerald-400",
  rejected: "bg-red-500/15 text-red-400",
};

function OfferTable({ offers }) {
  return (
    <div className="overflow-x-auto rounded-lg"><table className="w-full text-sm">
      <thead>
        <tr className="bg-slate-800 text-left text-slate-400">
          <th className="px-3 py-2 font-medium">Name</th>
          <th className="px-3 py-2 font-medium">Pos</th>
          <th className="px-3 py-2 text-right font-medium">OVR</th>
          <th className="px-3 py-2 text-right font-medium">Your Offer</th>
        </tr>
      </thead>
      <tbody>
        {offers.map(({ player, offer }) => (
          <tr key={player.id} className="border-b border-slate-800 last:border-0">
            <td className="px-3 py-2 text-slate-100">{player.name}</td>
            <td className="px-3 py-2 text-slate-300">{player.position}</td>
            <td className="px-3 py-2 text-right text-slate-300">{player.overall}</td>
            <td className="px-3 py-2 text-right text-sky-400">
              ${offer.aavMillions.toFixed(3)}M / {offer.years}yr
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

function describeAssets(players, picks) {
  const parts = [...players.map((p) => p.name), ...picks.map((p) => `${draftYear(p.seasonNumber)} R${p.round} pick`)];
  return parts.length > 0 ? parts.join(", ") : "Nothing";
}

function Section({ title, children }) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold text-slate-300">{title}</h3>
      {children}
    </section>
  );
}

export default function PendingMoves() {
  const { myTeamId } = useMyTeam();
  const [moves, setMoves] = useState(null);
  const [error, setError] = useState(null);

  const reload = () => {
    if (myTeamId == null) return;
    api.getPendingMoves(myTeamId).then(setMoves).catch((e) => setError(e.message));
  };

  useEffect(reload, [myTeamId]);

  if (error) return <p className="text-red-500">{error}</p>;
  if (myTeamId == null || !moves) return <p className="text-slate-400">Loading pending moves…</p>;

  const { freeAgentOffers, resignOffers, tradeOffers } = moves;

  return (
    <div className="flex flex-col gap-8">
      <Section title="Free Agent Offers">
        {freeAgentOffers.length === 0 ? (
          <p className="text-sm text-slate-500">No pending free agent offers.</p>
        ) : (
          <OfferTable offers={freeAgentOffers} />
        )}
      </Section>

      <Section title="Re-sign Offers">
        {resignOffers.length === 0 ? (
          <p className="text-sm text-slate-500">No pending re-sign offers.</p>
        ) : (
          <OfferTable offers={resignOffers} />
        )}
      </Section>

      <Section title="Trade Offers">
        {tradeOffers.length === 0 ? (
          <p className="text-sm text-slate-500">No pending trade proposals.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg"><table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-800 text-left text-slate-400">
                <th className="px-3 py-2 font-medium">Target Team</th>
                <th className="px-3 py-2 font-medium">You Offer</th>
                <th className="px-3 py-2 font-medium">You Want</th>
                <th className="px-3 py-2 font-medium">Value</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {tradeOffers.map((p, i) => (
                <tr key={p.id} className={i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/50"}>
                  <td className="px-3 py-2 text-slate-300">
                    {p.targetTeam.city} {p.targetTeam.name}
                  </td>
                  <td className="px-3 py-2 text-slate-400">{describeAssets(p.offeredPlayers, p.offeredPicks)}</td>
                  <td className="px-3 py-2 text-slate-400">{describeAssets(p.requestedPlayers, p.requestedPicks)}</td>
                  <td className="px-3 py-2">
                    <TradeValueBar value={p.offeredValue} max={85} colorClass="bg-sky-400" />
                  </td>
                  <td className="px-3 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_STYLES[p.status]}`}>
                      {p.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </Section>
    </div>
  );
}

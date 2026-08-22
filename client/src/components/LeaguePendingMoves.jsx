import { useEffect, useState } from "react";
import { api } from "../api";
import { draftYear } from "../seasonYear";
import TradeValueBar from "./TradeValueBar";

function describeAssets(players, picks) {
  const parts = [...players.map((p) => p.name), ...picks.map((p) => `${draftYear(p.seasonNumber)} R${p.round} pick`)];
  return parts.length > 0 ? parts.join(", ") : "Nothing";
}

function teamLabel(team) {
  return team ? `${team.city} ${team.name}` : "—";
}

function Section({ title, count, children }) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold text-slate-300">
        {title} {count > 0 && <span className="text-slate-500">({count})</span>}
      </h3>
      {children}
    </section>
  );
}

function OfferTable({ offers }) {
  return (
    <div className="overflow-x-auto rounded-lg">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-slate-800 text-left text-slate-400">
            <th className="px-3 py-2 font-medium">Team</th>
            <th className="px-3 py-2 font-medium">Player</th>
            <th className="px-3 py-2 font-medium">Pos</th>
            <th className="px-3 py-2 text-right font-medium">OVR</th>
            <th className="px-3 py-2 text-right font-medium">Offer</th>
          </tr>
        </thead>
        <tbody>
          {offers.map(({ team, player, offer }, i) => (
            <tr key={`${team.id}-${player.id}`} className={i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/50"}>
              <td className="px-3 py-2 text-slate-100">{teamLabel(team)}</td>
              <td className="px-3 py-2 text-slate-300">{player.name}</td>
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

export default function LeaguePendingMoves() {
  const [moves, setMoves] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getLeagueWidePendingMoves().then(setMoves).catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="text-red-500">{error}</p>;
  if (!moves) return <p className="text-slate-400">Loading pending moves…</p>;

  const { freeAgentBids, resignOffers, humanTrades, cpuTargetTrades } = moves;

  return (
    <div className="flex flex-col gap-8">
      <p className="text-xs text-slate-500">
        Everything currently in motion across every human team — visible only here, not on any individual GM's own
        view.
      </p>

      <Section title="Free Agent Bids" count={freeAgentBids.length}>
        {freeAgentBids.length === 0 ? (
          <p className="text-sm text-slate-500">No pending free agent bids this round.</p>
        ) : (
          <OfferTable offers={freeAgentBids} />
        )}
      </Section>

      <Section title="Re-sign Offers" count={resignOffers.length}>
        {resignOffers.length === 0 ? (
          <p className="text-sm text-slate-500">No pending re-sign offers this round.</p>
        ) : (
          <OfferTable offers={resignOffers} />
        )}
      </Section>

      <Section title="Trades With Other GMs" count={humanTrades.length}>
        {humanTrades.length === 0 ? (
          <p className="text-sm text-slate-500">No pending human-to-human trade offers.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-800 text-left text-slate-400">
                  <th className="px-3 py-2 font-medium">Proposing Team</th>
                  <th className="px-3 py-2 font-medium">Target Team</th>
                  <th className="px-3 py-2 font-medium">Offers</th>
                  <th className="px-3 py-2 font-medium">Wants</th>
                </tr>
              </thead>
              <tbody>
                {humanTrades.map((t, i) => (
                  <tr key={i} className={i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/50"}>
                    <td className="px-3 py-2 text-slate-100">{teamLabel(t.proposingTeam)}</td>
                    <td className="px-3 py-2 text-slate-100">{teamLabel(t.targetTeam)}</td>
                    <td className="px-3 py-2 text-slate-400">{describeAssets(t.offered.players, t.offered.picks)}</td>
                    <td className="px-3 py-2 text-slate-400">{describeAssets(t.requested.players, t.requested.picks)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Trade Proposals to CPU Teams" count={cpuTargetTrades.length}>
        {cpuTargetTrades.length === 0 ? (
          <p className="text-sm text-slate-500">No pending trade proposals to CPU teams this round.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-800 text-left text-slate-400">
                  <th className="px-3 py-2 font-medium">Proposing Team</th>
                  <th className="px-3 py-2 font-medium">Target Team</th>
                  <th className="px-3 py-2 font-medium">Offers</th>
                  <th className="px-3 py-2 font-medium">Value</th>
                </tr>
              </thead>
              <tbody>
                {cpuTargetTrades.map((t, i) => (
                  <tr key={i} className={i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/50"}>
                    <td className="px-3 py-2 text-slate-100">{teamLabel(t.proposingTeam)}</td>
                    <td className="px-3 py-2 text-slate-100">{teamLabel(t.targetTeam)}</td>
                    <td className="px-3 py-2 text-slate-400">{describeAssets(t.offered.players, t.offered.picks)}</td>
                    <td className="px-3 py-2">
                      <TradeValueBar value={t.requestedValue} max={85} colorClass="bg-sky-400" />
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

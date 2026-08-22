import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useMyTeam } from "../MyTeamContext";
import { useLeaguePhase } from "../LeaguePhaseContext";
import { PHASE_LABELS } from "../phaseLabels";
import { draftYear } from "../seasonYear";
import { sortRows } from "../sortUtils";
import StarRating, { CONFIDENCE_COLORS } from "./StarRating";
import SortableHeader from "./SortableHeader";
import TradeValueBar from "./TradeValueBar";
import TradeBalanceBar from "./TradeBalanceBar";

const MAX_ASSETS = 5;
const PROPOSAL_PHASES = ["trade_period", "post_playoff_trade"];

const INTEREST_STYLES = {
  "Not interested": "bg-red-500/15 text-red-400",
  "Slightly interested": "bg-orange-500/15 text-orange-400",
  Interested: "bg-yellow-500/15 text-yellow-400",
  "Very interested": "bg-lime-500/15 text-lime-400",
  "Highly interested": "bg-emerald-500/15 text-emerald-400",
};

const STATUS_STYLES = {
  pending: "bg-slate-500/15 text-slate-400",
  executed: "bg-emerald-500/15 text-emerald-400",
  accepted: "bg-emerald-500/15 text-emerald-400",
  rejected: "bg-red-500/15 text-red-400",
  declined: "bg-red-500/15 text-red-400",
  expired: "bg-red-500/15 text-red-400",
  withdrawn: "bg-slate-500/15 text-slate-400",
};

const NEED_STYLES = {
  "Very High": "bg-red-500/15 text-red-400",
  High: "bg-orange-500/15 text-orange-400",
  Moderate: "bg-yellow-500/15 text-yellow-400",
  Low: "bg-lime-500/15 text-lime-400",
  "Very Low": "bg-emerald-500/15 text-emerald-400",
};

const NEED_CATEGORY_LABELS = { forwards: "Forwards", defense: "Defense", goalies: "Goalies", picks: "Draft Picks" };

function TeamNeedsPanel({ needs }) {
  if (!needs) return null;
  return (
    <div className="mb-3 grid grid-cols-2 gap-1.5 rounded-md border border-slate-800 bg-slate-950 p-2 sm:grid-cols-4">
      {Object.entries(NEED_CATEGORY_LABELS).map(([key, label]) => (
        <div key={key} className="flex flex-col items-center gap-1 text-center">
          <span className="text-[11px] text-slate-500">{label}</span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${NEED_STYLES[needs[key]]}`}>
            {needs[key]}
          </span>
        </div>
      ))}
    </div>
  );
}

const PLAYER_ACCESSORS = {
  name: (p) => p.name,
  position: (p) => p.position,
  age: (p) => p.age,
  overall: (p) => p.overall,
  potential: (p) => p.potential.stars,
  tradeValue: (p) => p.tradeValue,
};

const PICK_ACCESSORS = {
  seasonNumber: (p) => p.seasonNumber,
  round: (p) => p.round,
  overallPickNumber: (p) => p.overallPickNumber,
  tradeValue: (p) => p.tradeValue,
};

function rowClass(isSelected, isDisabled) {
  return `cursor-pointer border-b border-slate-800 text-sm last:border-0 transition-colors ${
    isSelected
      ? "bg-sky-500/10 ring-1 ring-inset ring-sky-400"
      : isDisabled
        ? "cursor-default opacity-40"
        : "hover:bg-slate-800/60"
  }`;
}

function AssetColumn({ label, teamLabel, teams, excludeTeamId, teamId, onTeamChange, needs, players, picks, selected, onToggle }) {
  const count = selected.playerIds.size + selected.pickIds.size;
  const [playerSort, setPlayerSort] = useState({ key: null, dir: "desc" });
  const [pickSort, setPickSort] = useState({ key: null, dir: "desc" });

  const handleSort = (setSort) => (key) => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));
  };

  const sortedPlayers = useMemo(
    () => sortRows(players, PLAYER_ACCESSORS, playerSort.key, playerSort.dir),
    [players, playerSort]
  );
  const sortedPicks = useMemo(() => sortRows(picks, PICK_ACCESSORS, pickSort.key, pickSort.dir), [picks, pickSort]);

  return (
    <div className="flex-1">
      <div className="mb-2 flex items-center justify-between">
        <label className="text-sm text-slate-400">{label}</label>
        <span className={`text-xs ${count >= MAX_ASSETS ? "text-amber-400" : "text-slate-500"}`}>
          {count}/{MAX_ASSETS} selected
        </span>
      </div>
      {onTeamChange ? (
        <select
          className="mb-3 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-slate-100"
          value={teamId ?? ""}
          onChange={(e) => onTeamChange(Number(e.target.value))}
        >
          {teams
            .filter((t) => t.id !== excludeTeamId)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.city} {t.name}
                {t.isHumanControlled ? " (Human GM)" : ""}
              </option>
            ))}
        </select>
      ) : (
        <div className="mb-3 w-full rounded-md border border-slate-800 bg-slate-900 px-3 py-1.5 text-slate-300">
          {teamLabel}
        </div>
      )}

      <TeamNeedsPanel needs={needs} />

      <div className="max-h-96 overflow-auto rounded-lg bg-slate-900">
        {players.length > 0 && (
          <table className="w-full min-w-[420px] text-sm">
            <thead className="sticky top-0 z-10 bg-slate-800">
              <tr className="text-left text-slate-400">
                <SortableHeader label="Player" sortKey="name" currentKey={playerSort.key} direction={playerSort.dir} onSort={handleSort(setPlayerSort)} />
                <SortableHeader label="Pos" sortKey="position" currentKey={playerSort.key} direction={playerSort.dir} onSort={handleSort(setPlayerSort)} />
                <SortableHeader label="Age" sortKey="age" currentKey={playerSort.key} direction={playerSort.dir} onSort={handleSort(setPlayerSort)} align="right" />
                <SortableHeader label="OVR" sortKey="overall" currentKey={playerSort.key} direction={playerSort.dir} onSort={handleSort(setPlayerSort)} align="right" />
                <SortableHeader label="Potential" sortKey="potential" currentKey={playerSort.key} direction={playerSort.dir} onSort={handleSort(setPlayerSort)} />
                <SortableHeader label="Value" sortKey="tradeValue" currentKey={playerSort.key} direction={playerSort.dir} onSort={handleSort(setPlayerSort)} />
              </tr>
            </thead>
            <tbody>
              {sortedPlayers.map((p) => {
                const isSelected = selected.playerIds.has(p.id);
                const isDisabled = !isSelected && count >= MAX_ASSETS;
                return (
                  <tr
                    key={p.id}
                    onClick={() => !isDisabled && onToggle("playerIds", p.id)}
                    className={rowClass(isSelected, isDisabled)}
                  >
                    <td className={`px-2 py-1.5 ${isSelected ? "text-sky-300" : "text-slate-100"}`}>{p.name}</td>
                    <td className="px-2 py-1.5 text-slate-300">{p.position}</td>
                    <td className="px-2 py-1.5 text-right text-slate-300">{p.age}</td>
                    <td className="px-2 py-1.5 text-right text-slate-300">{p.overall}</td>
                    <td className="px-2 py-1.5">
                      <StarRating value={p.potential.stars} colorClass={CONFIDENCE_COLORS[p.potential.confidence]} />
                    </td>
                    <td className="px-2 py-1.5">
                      <TradeValueBar value={p.tradeValue} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {picks.length > 0 && (
          <table className="w-full min-w-[420px] text-sm">
            <thead className="sticky top-0 z-10 bg-slate-800">
              <tr className="text-left text-slate-400">
                <SortableHeader label="Year" sortKey="seasonNumber" currentKey={pickSort.key} direction={pickSort.dir} onSort={handleSort(setPickSort)} />
                <SortableHeader label="Rd" sortKey="round" currentKey={pickSort.key} direction={pickSort.dir} onSort={handleSort(setPickSort)} align="right" />
                <SortableHeader label="Pick #" sortKey="overallPickNumber" currentKey={pickSort.key} direction={pickSort.dir} onSort={handleSort(setPickSort)} align="right" />
                <th className="px-2 py-2 font-medium">Orig</th>
                <SortableHeader label="Value" sortKey="tradeValue" currentKey={pickSort.key} direction={pickSort.dir} onSort={handleSort(setPickSort)} />
              </tr>
            </thead>
            <tbody>
              {sortedPicks.map((pick) => {
                const isSelected = selected.pickIds.has(pick.id);
                const isDisabled = !isSelected && count >= MAX_ASSETS;
                return (
                  <tr
                    key={pick.id}
                    onClick={() => !isDisabled && onToggle("pickIds", pick.id)}
                    className={rowClass(isSelected, isDisabled)}
                  >
                    <td className={`px-2 py-1.5 ${isSelected ? "text-sky-300" : "text-slate-100"}`}>
                      {draftYear(pick.seasonNumber)}
                    </td>
                    <td className="px-2 py-1.5 text-right text-slate-300">{pick.round}</td>
                    <td className="px-2 py-1.5 text-right text-slate-300">#{pick.overallPickNumber} proj.</td>
                    <td className="px-2 py-1.5 text-slate-300">{pick.originalTeam.abbr}</td>
                    <td className="px-2 py-1.5">
                      <TradeValueBar value={pick.tradeValue} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {players.length === 0 && picks.length === 0 && <p className="px-3 py-2 text-sm text-slate-600">Empty roster.</p>}
      </div>
    </div>
  );
}

function emptySelection() {
  return { playerIds: new Set(), pickIds: new Set() };
}

function describeAssets(side) {
  const parts = [
    ...side.players.map((p) => p.name),
    ...side.picks.map((p) => `${draftYear(p.seasonNumber)} R${p.round}`),
  ];
  return parts.length > 0 ? parts.join(", ") : "Nothing selected";
}

function describeProposalAssets(players, picks) {
  const parts = [...players.map((p) => p.name), ...picks.map((p) => `${draftYear(p.seasonNumber)} R${p.round}`)];
  return parts.length > 0 ? parts.join(", ") : "—";
}

export default function TradeCenter() {
  const { myTeamId, teams: myTeams } = useMyTeam();
  const { phase } = useLeaguePhase();
  const [teams, setTeams] = useState([]);
  const [teamBId, setTeamBId] = useState(null);
  const [teamAPlayers, setTeamAPlayers] = useState([]);
  const [teamAPicks, setTeamAPicks] = useState([]);
  const [teamANeeds, setTeamANeeds] = useState(null);
  const [teamBPlayers, setTeamBPlayers] = useState([]);
  const [teamBPicks, setTeamBPicks] = useState([]);
  const [teamBNeeds, setTeamBNeeds] = useState(null);
  const [selectedA, setSelectedA] = useState(emptySelection());
  const [selectedB, setSelectedB] = useState(emptySelection());
  const [evaluation, setEvaluation] = useState(null);
  const [evaluating, setEvaluating] = useState(false);
  const [proposals, setProposals] = useState([]);
  const [cpuOffers, setCpuOffers] = useState([]);
  const [humanOffers, setHumanOffers] = useState({ incoming: [], outgoing: [] });
  const [respondingId, setRespondingId] = useState(null);
  const [respondingHumanId, setRespondingHumanId] = useState(null);
  const [withdrawingId, setWithdrawingId] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [resultMessage, setResultMessage] = useState(null);

  const loadProposals = () => {
    if (myTeamId == null) return;
    api.getTradeProposals(myTeamId).then(setProposals).catch((e) => setError(e.message));
  };

  const loadCpuOffers = () => {
    if (myTeamId == null) return;
    api.getCpuTradeOffers().then(setCpuOffers).catch((e) => setError(e.message));
  };

  const loadHumanOffers = () => {
    if (myTeamId == null) return;
    api.getHumanTradeOffers().then(setHumanOffers).catch((e) => setError(e.message));
  };

  useEffect(loadProposals, [myTeamId]);
  useEffect(loadCpuOffers, [myTeamId]);
  useEffect(loadHumanOffers, [myTeamId]);

  useEffect(() => {
    api
      .getTeams()
      .then((t) => {
        setTeams(t);
        setTeamBId((prev) => (prev != null && prev !== myTeamId ? prev : t.find((team) => team.id !== myTeamId)?.id ?? null));
      })
      .catch((e) => setError(e.message));
  }, [myTeamId]);

  useEffect(() => {
    if (myTeamId == null) return;
    setSelectedA(emptySelection());
    setEvaluation(null);
    Promise.all([api.getRoster(myTeamId), api.getDraftPicks(myTeamId), api.getTeamNeeds(myTeamId)])
      .then(([roster, picks, needs]) => {
        setTeamAPlayers(roster.roster);
        setTeamAPicks(picks);
        setTeamANeeds(needs);
      })
      .catch((e) => setError(e.message));
  }, [myTeamId]);

  useEffect(() => {
    if (teamBId == null) return;
    setSelectedB(emptySelection());
    setEvaluation(null);
    Promise.all([api.getRoster(teamBId), api.getDraftPicks(teamBId), api.getTeamNeeds(teamBId)])
      .then(([roster, picks, needs]) => {
        setTeamBPlayers(roster.roster);
        setTeamBPicks(picks);
        setTeamBNeeds(needs);
      })
      .catch((e) => setError(e.message));
  }, [teamBId]);

  const toggle = (setter) => (kind, id) => {
    setter((prev) => {
      const next = { playerIds: new Set(prev.playerIds), pickIds: new Set(prev.pickIds) };
      const set = next[kind];
      if (set.has(id)) set.delete(id);
      else set.add(id);
      return next;
    });
    setResultMessage(null);
  };

  const offeredA = selectedA.playerIds.size + selectedA.pickIds.size;
  const offeredB = selectedB.playerIds.size + selectedB.pickIds.size;
  const canEvaluate = offeredA > 0 && offeredB > 0 && myTeamId != null && teamBId != null;

  const targetTeam = teams.find((t) => t.id === teamBId);
  const isCpuTarget = Boolean(targetTeam && !targetTeam.isHumanControlled);
  const proposalPhaseOpen = Boolean(phase && PROPOSAL_PHASES.includes(phase.phase));

  // Auto-evaluates the instant a selection changes on either side — no
  // button to press. Server rejects a side with zero assets, so this only
  // ever fires once both sides actually have something offered. This is
  // purely a preview (no persistence) so it runs the same way regardless of
  // whether the eventual action is an instant execute or a submitted
  // proposal.
  useEffect(() => {
    if (!canEvaluate) {
      setEvaluation(null);
      return;
    }
    let cancelled = false;
    setEvaluating(true);
    setError(null);
    const payload = {
      teamAId: myTeamId,
      teamBId,
      teamAAssets: { playerIds: [...selectedA.playerIds], pickIds: [...selectedA.pickIds] },
      teamBAssets: { playerIds: [...selectedB.playerIds], pickIds: [...selectedB.pickIds] },
    };
    api
      .evaluateTrade(payload)
      .then((res) => {
        if (!cancelled) setEvaluation(res);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setEvaluating(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myTeamId, teamBId, selectedA, selectedB]);

  const handleProposeToHuman = async () => {
    if (!evaluation) return;
    setBusy(true);
    setError(null);
    try {
      const payload = {
        teamAId: myTeamId,
        teamBId,
        teamAAssets: { playerIds: [...selectedA.playerIds], pickIds: [...selectedA.pickIds] },
        teamBAssets: { playerIds: [...selectedB.playerIds], pickIds: [...selectedB.pickIds] },
      };
      await api.proposeTrade(payload);
      setResultMessage("Offer sent — nothing moves until they accept it.");
      setSelectedA(emptySelection());
      setSelectedB(emptySelection());
      loadHumanOffers();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const refreshBothRosters = async () => {
    const [rosterA, picksA] = await Promise.all([api.getRoster(myTeamId), api.getDraftPicks(myTeamId)]);
    setTeamAPlayers(rosterA.roster);
    setTeamAPicks(picksA);
    if (teamBId != null) {
      const [rosterB, picksB] = await Promise.all([api.getRoster(teamBId), api.getDraftPicks(teamBId)]);
      setTeamBPlayers(rosterB.roster);
      setTeamBPicks(picksB);
    }
  };

  const handleRespondToHumanOffer = async (offerId, accept) => {
    setRespondingHumanId(offerId);
    setError(null);
    try {
      await api.respondToHumanTradeOffer(offerId, accept);
      setResultMessage(accept ? "Trade accepted — assets have moved teams." : "Offer declined.");
      loadHumanOffers();
      if (accept) await refreshBothRosters();
    } catch (e) {
      setError(e.message);
    } finally {
      setRespondingHumanId(null);
    }
  };

  const handleWithdrawHumanOffer = async (offerId) => {
    setWithdrawingId(offerId);
    setError(null);
    try {
      await api.withdrawHumanTradeOffer(offerId);
      loadHumanOffers();
    } catch (e) {
      setError(e.message);
    } finally {
      setWithdrawingId(null);
    }
  };

  const handleSubmitProposal = async () => {
    if (!evaluation) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.submitTradeProposal({
        teamId: myTeamId,
        targetTeamId: teamBId,
        offeredPlayerIds: [...selectedA.playerIds],
        offeredPickIds: [...selectedA.pickIds],
        requestedPlayerIds: [...selectedB.playerIds],
        requestedPickIds: [...selectedB.pickIds],
      });
      setProposals(updated);
      setResultMessage("Proposal submitted — resolved when this round ends.");
      setSelectedA(emptySelection());
      setSelectedB(emptySelection());
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleRespondToCpuOffer = async (offerId, accept) => {
    setRespondingId(offerId);
    setError(null);
    try {
      await api.respondToCpuTradeOffer(offerId, accept);
      setResultMessage(accept ? "Trade accepted — assets have moved teams." : "Offer declined.");
      loadCpuOffers();
      if (accept) {
        const [rosterA, picksA] = await Promise.all([api.getRoster(myTeamId), api.getDraftPicks(myTeamId)]);
        setTeamAPlayers(rosterA.roster);
        setTeamAPicks(picksA);
        if (teamBId != null) {
          const [rosterB, picksB] = await Promise.all([api.getRoster(teamBId), api.getDraftPicks(teamBId)]);
          setTeamBPlayers(rosterB.roster);
          setTeamBPicks(picksB);
        }
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setRespondingId(null);
    }
  };

  if (teams.length === 0 || myTeamId == null) return <p className="text-slate-400">Loading teams…</p>;

  const myTeam = myTeams.find((t) => t.id === myTeamId) ?? teams.find((t) => t.id === myTeamId);
  const capBlocked = Boolean(evaluation && (evaluation.teamA.capImpact.overCap || evaluation.teamB.capImpact.overCap));
  const actionDisabled = !evaluation || busy || (isCpuTarget && !proposalPhaseOpen) || capBlocked;

  const pendingCpuOffers = cpuOffers.filter((o) => o.status === "pending");

  return (
    <div>
      <div className="mb-6 rounded-lg bg-slate-900 p-4">
        <h3 className="mb-1 text-sm font-semibold text-slate-300">Incoming CPU Offers</h3>
        <p className="mb-3 text-xs text-slate-500">CPU teams proposing trades to you this round — accept or decline each one.</p>
        {pendingCpuOffers.length === 0 ? (
          <p className="text-sm text-slate-500">No incoming trade offers right now.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {pendingCpuOffers.map((offer) => (
              <div key={offer.id} className="rounded-lg border border-slate-800 bg-slate-950 p-3">
                <div className="mb-2 text-sm font-medium text-slate-100">
                  {offer.cpuTeam.city} {offer.cpuTeam.name}
                </div>
                <div className="grid gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <span className="text-slate-500">They send:</span>{" "}
                    <span className="text-slate-100">
                      {describeProposalAssets(offer.cpuSends.players, offer.cpuSends.picks)}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500">They want:</span>{" "}
                    <span className="text-slate-100">
                      {describeProposalAssets(offer.cpuWants.players, offer.cpuWants.picks)}
                    </span>
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleRespondToCpuOffer(offer.id, true)}
                    disabled={respondingId === offer.id}
                    className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                  >
                    {respondingId === offer.id ? "Working…" : "Accept"}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRespondToCpuOffer(offer.id, false)}
                    disabled={respondingId === offer.id}
                    className="rounded-md bg-slate-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-600 disabled:opacity-50"
                  >
                    Decline
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mb-6 rounded-lg bg-slate-900 p-4">
        <h3 className="mb-1 text-sm font-semibold text-slate-300">Offers With Other GMs</h3>
        <p className="mb-3 text-xs text-slate-500">
          Direct offers you've sent or received don't move anything until the other GM accepts.
        </p>

        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Awaiting Your Response</h4>
        {humanOffers.incoming.length === 0 ? (
          <p className="mb-4 text-sm text-slate-500">No incoming offers right now.</p>
        ) : (
          <div className="mb-4 flex flex-col gap-3">
            {humanOffers.incoming.map((offer) => (
              <div key={offer.id} className="rounded-lg border border-slate-800 bg-slate-950 p-3">
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="font-medium text-slate-100">
                    {offer.proposingTeam.city} {offer.proposingTeam.name}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_STYLES[offer.status] || "bg-slate-500/15 text-slate-400"}`}>
                    {offer.status}
                  </span>
                </div>
                <div className="grid gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <span className="text-slate-500">They send:</span>{" "}
                    <span className="text-slate-100">{describeProposalAssets(offer.offered.players, offer.offered.picks)}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">They want:</span>{" "}
                    <span className="text-slate-100">{describeProposalAssets(offer.requested.players, offer.requested.picks)}</span>
                  </div>
                </div>
                {offer.status === "pending" && (
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleRespondToHumanOffer(offer.id, true)}
                      disabled={respondingHumanId === offer.id}
                      className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                    >
                      {respondingHumanId === offer.id ? "Working…" : "Accept"}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRespondToHumanOffer(offer.id, false)}
                      disabled={respondingHumanId === offer.id}
                      className="rounded-md bg-slate-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-600 disabled:opacity-50"
                    >
                      Decline
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Sent By You</h4>
        {humanOffers.outgoing.length === 0 ? (
          <p className="text-sm text-slate-500">You haven't sent any offers yet.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {humanOffers.outgoing.map((offer) => (
              <div key={offer.id} className="rounded-lg border border-slate-800 bg-slate-950 p-3">
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="font-medium text-slate-100">
                    {offer.targetTeam.city} {offer.targetTeam.name}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_STYLES[offer.status] || "bg-slate-500/15 text-slate-400"}`}>
                    {offer.status}
                  </span>
                </div>
                <div className="grid gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <span className="text-slate-500">You send:</span>{" "}
                    <span className="text-slate-100">{describeProposalAssets(offer.offered.players, offer.offered.picks)}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">You want:</span>{" "}
                    <span className="text-slate-100">{describeProposalAssets(offer.requested.players, offer.requested.picks)}</span>
                  </div>
                </div>
                {offer.status === "pending" && (
                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={() => handleWithdrawHumanOffer(offer.id)}
                      disabled={withdrawingId === offer.id}
                      className="rounded-md bg-slate-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-600 disabled:opacity-50"
                    >
                      {withdrawingId === offer.id ? "Withdrawing…" : "Withdraw"}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-4 sm:flex-row">
        <AssetColumn
          label="Your team sends"
          teamLabel={myTeam ? `${myTeam.city} ${myTeam.name}` : "—"}
          needs={teamANeeds}
          players={teamAPlayers}
          picks={teamAPicks}
          selected={selectedA}
          onToggle={toggle(setSelectedA)}
        />
        <AssetColumn
          label={isCpuTarget ? "You're requesting" : "Their team sends"}
          teams={teams}
          excludeTeamId={myTeamId}
          teamId={teamBId}
          onTeamChange={setTeamBId}
          needs={teamBNeeds}
          players={teamBPlayers}
          picks={teamBPicks}
          selected={selectedB}
          onToggle={toggle(setSelectedB)}
        />
      </div>

      <div className="mt-6 rounded-lg bg-slate-900 p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-300">Trade Summary</h3>

        {!canEvaluate ? (
          <p className="text-sm text-slate-500">Click players or picks from both sides to build an offer.</p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="text-sm">
                <span className="text-slate-400">
                  {myTeam ? `${myTeam.city} ${myTeam.name}` : "You"} send:
                </span>{" "}
                <span className="text-slate-100">
                  {evaluation ? describeAssets(evaluation.teamA) : "…"}
                </span>
              </div>
              <div className="text-sm">
                <span className="text-slate-400">
                  {targetTeam ? `${targetTeam.city} ${targetTeam.name}` : ""} {isCpuTarget ? "would send" : "send"}:
                </span>{" "}
                <span className="text-slate-100">
                  {evaluation ? describeAssets(evaluation.teamB) : "…"}
                </span>
              </div>
            </div>

            {evaluation && (
              <div className="mt-4">
                <TradeBalanceBar
                  leftValue={evaluation.teamA.totalValueGiven}
                  leftLabel={evaluation.teamA.team.abbr}
                  rightValue={evaluation.teamB.totalValueGiven}
                  rightLabel={evaluation.teamB.team.abbr}
                />
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  {[evaluation.teamA, evaluation.teamB].map((side) => (
                    <span
                      key={side.team.id}
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${INTEREST_STYLES[side.interest.label]}`}
                    >
                      {side.team.abbr}: {side.interest.label}
                    </span>
                  ))}
                  {evaluating && <span className="text-xs text-slate-500">Updating…</span>}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                  {[evaluation.teamA, evaluation.teamB].map((side) => (
                    <span
                      key={side.team.id}
                      className={side.capImpact.overCap ? "font-medium text-red-400" : "text-slate-500"}
                    >
                      {side.team.abbr} post-trade cap: ${side.capImpact.projected.toFixed(2)}M / ${side.capImpact.ceiling.toFixed(1)}M
                      {side.capImpact.overCap ? " — over the cap, trade blocked" : ""}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {isCpuTarget ? (
              <p className="mt-3 text-xs text-slate-500">
                {proposalPhaseOpen
                  ? "This is a proposal, not an instant trade — it resolves when the current round ends, and other GMs may be offering for the same assets."
                  : `Trade proposals to CPU teams only open during the Trade Period or Post-Playoff Trade Round (currently ${
                      PHASE_LABELS[phase?.phase] || phase?.phase
                    }).`}
              </p>
            ) : (
              <p className="mt-3 text-xs text-slate-500">
                This sends a direct offer — nothing moves until {targetTeam ? `${targetTeam.city} ${targetTeam.name}` : "they"} accept it.
              </p>
            )}

            <div className="mt-4 flex items-center gap-3">
              <button
                type="button"
                onClick={isCpuTarget ? handleSubmitProposal : handleProposeToHuman}
                disabled={actionDisabled}
                className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {busy ? "Working…" : isCpuTarget ? "Submit Proposal" : "Send Trade Offer"}
              </button>
              {error && <span className="text-sm text-red-400">{error}</span>}
              {resultMessage && <span className="text-sm text-emerald-400">{resultMessage}</span>}
            </div>
          </>
        )}
      </div>

      <div className="mt-6 rounded-lg bg-slate-900 p-4">
        <h3 className="mb-1 text-sm font-semibold text-slate-300">Your Pending Proposals This Round</h3>
        <p className="mb-3 text-xs text-slate-500">Only your own proposals — other GMs' offers stay private.</p>
        {proposals.length === 0 ? (
          <p className="text-sm text-slate-500">You haven't submitted any proposals yet this round.</p>
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
              {proposals.map((p, i) => (
                <tr key={p.id} className={i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/50"}>
                  <td className="px-3 py-2 text-slate-300">
                    {p.targetTeam.city} {p.targetTeam.name}
                  </td>
                  <td className="px-3 py-2 text-slate-400">{describeProposalAssets(p.offeredPlayers, p.offeredPicks)}</td>
                  <td className="px-3 py-2 text-slate-400">{describeProposalAssets(p.requestedPlayers, p.requestedPicks)}</td>
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
      </div>
    </div>
  );
}

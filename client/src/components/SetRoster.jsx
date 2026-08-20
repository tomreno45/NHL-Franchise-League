import { useEffect, useState } from "react";
import { api } from "../api";
import { useMyTeam } from "../MyTeamContext";

function groupByLine(slots) {
  const map = new Map();
  slots.forEach((s) => {
    const list = map.get(s.line) ?? [];
    list.push(s);
    map.set(s.line, list);
  });
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([line, list]) => ({ line, list }));
}

function SlotCard({ slotCode, positionLabel, player, selected, onClick }) {
  return (
    <button
      type="button"
      onClick={() => onClick(slotCode, player?.id ?? null)}
      className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
        selected ? "border-sky-400 bg-sky-500/10" : "border-slate-800 bg-slate-900 hover:bg-slate-800/60"
      }`}
    >
      <div className="flex items-center justify-between text-[11px] font-semibold uppercase text-slate-500">
        <span>{positionLabel}</span>
        {player && <span>{player.overall} OVR</span>}
      </div>
      <div className={`truncate text-sm ${player ? "text-slate-100" : "italic text-slate-600"}`}>
        {player ? player.name : "— empty —"}
      </div>
    </button>
  );
}

function PoolRow({ player, selected, onClick, targetSlot }) {
  return (
    <button
      type="button"
      onClick={() => onClick(targetSlot, player.id)}
      className={`flex w-full items-center justify-between border-b border-slate-800 px-3 py-1.5 text-left text-sm last:border-0 ${
        selected ? "bg-sky-500/10" : "hover:bg-slate-800/60"
      }`}
    >
      <span className={selected ? "text-sky-300" : "text-slate-100"}>{player.name}</span>
      <span className="text-xs text-slate-500">
        {player.position} · {player.overall} OVR
      </span>
    </button>
  );
}

// Arranges the active roster (dressed + scratched) into lines and scratches
// only — the minors boundary lives on the separate Roster Moves tab, since
// calling someone up or sending them down is a different kind of decision
// (and a different data set) than shuffling who's on which line.
export default function SetRoster() {
  const { myTeamId, teams } = useMyTeam();
  const [roster, setRoster] = useState(null);
  const [slotsMeta, setSlotsMeta] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const reload = () => {
    if (myTeamId == null) return;
    api
      .getRoster(myTeamId)
      .then((data) => setRoster(data.roster.filter((p) => p.lineupSlot !== "MINORS")))
      .catch((e) => setError(e.message));
  };

  useEffect(reload, [myTeamId]);

  useEffect(() => {
    api.getLineupSlots().then(setSlotsMeta).catch((e) => setError(e.message));
  }, []);

  const handleClick = async (targetSlot, occupantId) => {
    if (selectedId == null) {
      if (occupantId != null) setSelectedId(occupantId);
      return;
    }
    if (selectedId === occupantId) {
      setSelectedId(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.assignLineupSlot({ teamId: myTeamId, playerId: selectedId, targetSlot });
      reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      setSelectedId(null);
    }
  };

  if (myTeamId == null || !roster || !slotsMeta) return <p className="text-slate-400">Loading roster…</p>;

  const myTeam = teams.find((t) => t.id === myTeamId);
  const byId = new Map(roster.map((p) => [p.id, p]));
  const occupantOf = (slotCode) => roster.find((p) => p.lineupSlot === slotCode) ?? null;
  const selectedPlayer = selectedId != null ? byId.get(selectedId) : null;

  const forwardLines = groupByLine(slotsMeta.slots.filter((s) => s.group === "forward"));
  const defenseLines = groupByLine(slotsMeta.slots.filter((s) => s.group === "defense"));
  const goalieSlots = slotsMeta.slots.filter((s) => s.group === "goalie").sort((a, b) => a.line - b.line);
  const scratchPlayers = roster.filter((p) => p.lineupSlot === slotsMeta.scratchSlot);

  const dressedSkaters = forwardLines.flatMap((l) => l.list).length + defenseLines.flatMap((l) => l.list).length;
  const dressedSkatersFilled = roster.filter((p) =>
    slotsMeta.slots.some((s) => s.group !== "goalie" && s.slot === p.lineupSlot)
  ).length;
  const dressedGoalies = roster.filter((p) => goalieSlots.some((s) => s.slot === p.lineupSlot)).length;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="mb-1 text-lg font-semibold text-slate-100">{myTeam ? `${myTeam.city} ${myTeam.name}` : ""}</h2>
          <span className="text-sm text-slate-500">
            Click a player, then click another player or an empty slot to move them between lines and scratches. Head
            to Roster Moves to call players up from the minors or send them down.
          </span>
        </div>
        <div className="flex gap-4 text-xs text-slate-400">
          <span>
            Dressed Skaters: <span className="font-semibold text-slate-200">{dressedSkatersFilled}</span>/{dressedSkaters}
          </span>
          <span>
            Dressed Goalies: <span className="font-semibold text-slate-200">{dressedGoalies}</span>/{goalieSlots.length}
          </span>
          <span>
            Scratches: <span className="font-semibold text-slate-200">{scratchPlayers.length}</span>/{slotsMeta.maxScratches}
          </span>
        </div>
      </div>

      {selectedPlayer && (
        <p className="mb-3 text-sm text-sky-400">
          Moving <span className="font-semibold">{selectedPlayer.name}</span> — click a player or slot to place them, or
          click them again to cancel.
        </p>
      )}
      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-sm font-semibold text-slate-300">Forwards</h3>
          <div className="flex flex-col gap-3">
            {forwardLines.map(({ line, list }) => (
              <div key={line}>
                <div className="mb-1 text-xs font-medium text-slate-500">Line {line}</div>
                <div className="grid grid-cols-3 gap-2">
                  {list.map((s) => {
                    const player = occupantOf(s.slot);
                    return (
                      <SlotCard
                        key={s.slot}
                        slotCode={s.slot}
                        positionLabel={s.positionLabel}
                        player={player}
                        selected={player?.id === selectedId}
                        onClick={handleClick}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold text-slate-300">Defense</h3>
          <div className="flex flex-col gap-3">
            {defenseLines.map(({ line, list }) => (
              <div key={line}>
                <div className="mb-1 text-xs font-medium text-slate-500">Pair {line}</div>
                <div className="grid grid-cols-2 gap-2">
                  {list.map((s) => {
                    const player = occupantOf(s.slot);
                    return (
                      <SlotCard
                        key={s.slot}
                        slotCode={s.slot}
                        positionLabel={s.positionLabel}
                        player={player}
                        selected={player?.id === selectedId}
                        onClick={handleClick}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <h3 className="mb-2 mt-6 text-sm font-semibold text-slate-300">Goalies</h3>
          <div className="grid grid-cols-2 gap-2">
            {goalieSlots.map((s) => {
              const player = occupantOf(s.slot);
              return (
                <SlotCard
                  key={s.slot}
                  slotCode={s.slot}
                  positionLabel={s.positionLabel}
                  player={player}
                  selected={player?.id === selectedId}
                  onClick={handleClick}
                />
              );
            })}
          </div>
        </div>
      </div>

      <div className="mt-6">
        <h3 className="mb-2 text-sm font-semibold text-slate-300">
          Scratches ({scratchPlayers.length}/{slotsMeta.maxScratches})
        </h3>
        <div className="min-h-[3rem] max-w-md overflow-hidden rounded-lg bg-slate-900">
          {scratchPlayers.length === 0 ? (
            <p className="px-3 py-2 text-sm text-slate-600">No players scratched.</p>
          ) : (
            scratchPlayers.map((p) => (
              <PoolRow
                key={p.id}
                player={p}
                selected={p.id === selectedId}
                onClick={handleClick}
                targetSlot={slotsMeta.scratchSlot}
              />
            ))
          )}
        </div>
        {selectedPlayer && scratchPlayers.length < slotsMeta.maxScratches && (
          <button
            type="button"
            onClick={() => handleClick(slotsMeta.scratchSlot, null)}
            disabled={busy}
            className="mt-2 rounded-md bg-slate-700 px-2.5 py-1 text-xs font-medium text-slate-100 hover:bg-slate-600 disabled:opacity-50"
          >
            Scratch {selectedPlayer.name}
          </button>
        )}
      </div>
    </div>
  );
}

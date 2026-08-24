import StarRating, { CONFIDENCE_COLORS } from "./StarRating";
import PlayerAttributes from "./PlayerAttributes";
import TradeValueBar from "./TradeValueBar";

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

function Stat({ label, children }) {
  return (
    <div>
      <div className="hub-label">{label}</div>
      <div className="text-slate-100">{children}</div>
    </div>
  );
}

// Full player detail on tap — replaces the roster table's old inline
// expand-in-row panel, since that still needed the row's own columns
// (cap hit, trade value, etc.) visible around it to mean anything; a modal
// carries all of that with it instead, so it works the same regardless of
// how narrow the screen is.
export default function PlayerDetailModal({ player, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-slate-900 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-100">
              #{player.jerseyNumber} {player.name}
            </h2>
            <p className="text-sm text-slate-500">{player.position}</p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-slate-300">
            ✕
          </button>
        </div>

        <div className="mb-5 grid grid-cols-3 gap-4 rounded-lg bg-slate-950 p-4 text-sm sm:grid-cols-6">
          <Stat label="Age">{player.age}</Stat>
          <Stat label="OVR">{player.overall}</Stat>
          <Stat label="Potential">
            <StarRating value={player.potential.stars} colorClass={CONFIDENCE_COLORS[player.potential.confidence]} />
          </Stat>
          <Stat label="Cap Hit">${player.capHit.toFixed(2)}M</Stat>
          <Stat label="Yrs Left">{player.contractYearsLeft}</Stat>
          <Stat label="In-Game Status">
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[player.inGameStatus]}`}>
              {STATUS_LABELS[player.inGameStatus]}
            </span>
          </Stat>
        </div>

        <div className="mb-5">
          <div className="hub-label mb-1">Trade Value</div>
          <TradeValueBar value={player.tradeValue} />
        </div>

        <PlayerAttributes player={player} />
      </div>
    </div>
  );
}

// Trade value is intentionally never shown as a raw number to the user —
// only this bar. Scale is 1-20 internally (see computeTradeValue in
// server/store.js), but the UI only ever renders relative fill + color tier.
function tierColor(value) {
  if (value >= 14) return "bg-emerald-500";
  if (value >= 7) return "bg-yellow-400";
  return "bg-red-500";
}

// colorClass overrides the automatic red/yellow/green quality tiers — use
// this for aggregate values (like a trade offer's total) where "high" isn't
// really a quality signal the same way an individual asset's rating is.
export default function TradeValueBar({ value, max = 20, colorClass }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="h-2 w-20 overflow-hidden rounded-full bg-slate-700" title="Trade value">
      <div className={`h-full rounded-full ${colorClass || tierColor(value)}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

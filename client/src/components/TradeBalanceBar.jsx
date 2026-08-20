// A single bar split between both sides of a trade, proportional to what
// each side is giving up — even values split it exactly down the middle
// (2 vs 2 = 50/50), lopsided values shift the divider toward whichever side
// is giving more (10 vs 9 = ~53/47). Deliberately not two separate bars
// against a shared max, so "who's giving more" reads directly as which half
// is bigger, not as two numbers you have to compare yourself.
export default function TradeBalanceBar({ leftValue, leftLabel, rightValue, rightLabel }) {
  const total = leftValue + rightValue;
  const leftPct = total === 0 ? 50 : (leftValue / total) * 100;
  const rightPct = 100 - leftPct;

  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs text-slate-400">
        <span>
          {leftLabel} <span className="text-slate-300">· {leftValue}</span>
        </span>
        <span>
          {rightLabel} <span className="text-slate-300">· {rightValue}</span>
        </span>
      </div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-slate-800">
        <div className="h-full bg-sky-500 transition-[width] duration-300 ease-out" style={{ width: `${leftPct}%` }} />
        <div
          className="h-full bg-amber-500 transition-[width] duration-300 ease-out"
          style={{ width: `${rightPct}%` }}
        />
      </div>
    </div>
  );
}

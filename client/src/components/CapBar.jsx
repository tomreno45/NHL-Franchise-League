export default function CapBar({ committed, ceiling, space }) {
  const pct = Math.min(100, Math.max(0, (committed / ceiling) * 100));
  const overCap = space < 0;

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="hub-label">Salary Cap</span>
      <div className="h-2 w-32 overflow-hidden rounded-full bg-black/30">
        <div
          className={`h-full rounded-full ${overCap ? "bg-red-500" : "bg-cyan-400"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={overCap ? "font-semibold text-red-400" : "text-slate-200"}>
        ${committed.toFixed(2)}M / ${ceiling.toFixed(1)}M ({overCap ? "over by" : "space"} $
        {Math.abs(space).toFixed(2)}M)
      </span>
    </div>
  );
}

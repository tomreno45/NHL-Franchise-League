export default function PhaseLock({ currentLabel, availableLabel }) {
  return (
    <div className="flex min-h-[240px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-slate-800 bg-slate-900/40 text-center">
      <p className="text-sm font-semibold text-slate-300">Not available during {currentLabel}</p>
      <p className="text-xs text-slate-500">Opens during {availableLabel}</p>
    </div>
  );
}

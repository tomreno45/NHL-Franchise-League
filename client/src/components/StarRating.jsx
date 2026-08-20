const STAR_PATH =
  "M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.27 5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z";

// Confidence colors for the Potential rating: red = low chance of hitting the
// ceiling, yellow = average, green = high chance. White is used once a player
// turns 30 and growth mostly plateaus (see server/store.js resolvePotential).
export const CONFIDENCE_COLORS = {
  red: "fill-red-500",
  yellow: "fill-yellow-400",
  green: "fill-emerald-500",
  white: "fill-slate-300",
};

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function Star({ fraction, colorClass }) {
  return (
    <span className="relative inline-block h-4 w-4 shrink-0">
      <svg viewBox="0 0 24 24" className="absolute inset-0 h-4 w-4 fill-slate-700">
        <path d={STAR_PATH} />
      </svg>
      {fraction > 0 && (
        <span className="absolute inset-0 overflow-hidden" style={{ width: `${fraction * 100}%` }}>
          <svg viewBox="0 0 24 24" className={`h-4 w-4 ${colorClass}`}>
            <path d={STAR_PATH} />
          </svg>
        </span>
      )}
    </span>
  );
}

export default function StarRating({ value, colorClass = "fill-sky-400" }) {
  const stars = [];
  for (let i = 0; i < 5; i++) {
    stars.push(<Star key={i} fraction={clamp(value - i, 0, 1)} colorClass={colorClass} />);
  }
  return <span className="inline-flex gap-0.5">{stars}</span>;
}

import { useId } from "react";
import { getTeamColors } from "../teamColors";

// Relative luminance (WCAG) — decides whether the abbreviation reads better
// in white or near-black on top of the team's primary color.
function readableTextColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? "#0f172a" : "#f8fafc";
}

// A generic team-colored crest badge — real brand colors (see teamColors.js)
// in a gradient circle with the abbreviation as the mark, not a reproduction
// of any team's actual logo/wordmark artwork (trademarked, deliberately
// never used anywhere in this app — see the earlier NHL-27-style redesign).
export default function TeamLogo({ abbr, size = 40, className = "" }) {
  const gradientId = useId();
  const { primary, secondary } = getTeamColors(abbr);
  const textColor = readableTextColor(primary);
  // Font size is in viewBox units (fixed 0-100 space), not physical pixels —
  // the whole <svg> scales via width/height below, so a constant value here
  // keeps the abbreviation the same proportion of the circle at every size,
  // instead of shrinking faster than the circle does as `size` gets small.
  const fontSize = abbr.length >= 3 ? 32 : 40;

  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={`shrink-0 ${className}`}
      role="img"
      aria-label={`${abbr} team logo`}
    >
      <defs>
        <radialGradient id={gradientId} cx="35%" cy="30%" r="75%">
          <stop offset="0%" stopColor={primary} stopOpacity="1" />
          <stop offset="100%" stopColor={primary} stopOpacity="0.82" />
        </radialGradient>
      </defs>
      <circle cx="50" cy="50" r="47" fill={`url(#${gradientId})`} stroke={secondary} strokeWidth="4" />
      <circle cx="50" cy="50" r="47" fill="none" stroke="rgba(0,0,0,0.25)" strokeWidth="1" />
      <text
        x="50"
        y="52"
        textAnchor="middle"
        dominantBaseline="central"
        fill={textColor}
        fontSize={fontSize}
        fontWeight="800"
        fontFamily="inherit"
      >
        {abbr}
      </text>
    </svg>
  );
}

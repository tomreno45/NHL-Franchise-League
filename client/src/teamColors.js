// Real primary/secondary brand colors per team, keyed by abbreviation —
// colors are historical fact, not trademarked artwork, so these are safe to
// use directly (unlike the actual crest/wordmark images, which this app
// deliberately never reproduces — see TeamLogo.jsx). Used to build a
// generic colored badge per team instead of one flat cyan circle for all 32.
export const TEAM_COLORS = {
  ANA: { primary: "#F47A38", secondary: "#111111" },
  BOS: { primary: "#111111", secondary: "#FFB81C" },
  BUF: { primary: "#002654", secondary: "#FCB514" },
  CGY: { primary: "#C8102E", secondary: "#F1BE48" },
  CAR: { primary: "#CC0000", secondary: "#111111" },
  CHI: { primary: "#CF0A2C", secondary: "#111111" },
  COL: { primary: "#6F263D", secondary: "#236192" },
  CBJ: { primary: "#002654", secondary: "#CE1126" },
  DAL: { primary: "#006847", secondary: "#111111" },
  DET: { primary: "#CE1126", secondary: "#FFFFFF" },
  EDM: { primary: "#FF4C00", secondary: "#041E42" },
  FLA: { primary: "#C8102E", secondary: "#041E42" },
  LAK: { primary: "#111111", secondary: "#A2AAAD" },
  MIN: { primary: "#154734", secondary: "#A6192E" },
  MTL: { primary: "#AF1E2D", secondary: "#192168" },
  NSH: { primary: "#FFB81C", secondary: "#041E42" },
  NJD: { primary: "#CE1126", secondary: "#111111" },
  NYI: { primary: "#00539B", secondary: "#F47D30" },
  NYR: { primary: "#0038A8", secondary: "#CE1126" },
  OTT: { primary: "#C52032", secondary: "#C69214" },
  PHI: { primary: "#F74902", secondary: "#111111" },
  PIT: { primary: "#111111", secondary: "#FCB514" },
  SJS: { primary: "#006D75", secondary: "#111111" },
  SEA: { primary: "#001628", secondary: "#99D9D9" },
  STL: { primary: "#002F87", secondary: "#FCB514" },
  TBL: { primary: "#002868", secondary: "#FFFFFF" },
  TOR: { primary: "#00205B", secondary: "#FFFFFF" },
  UTA: { primary: "#010101", secondary: "#71AFE5" },
  VAN: { primary: "#00205B", secondary: "#00843D" },
  VGK: { primary: "#333F42", secondary: "#B4975A" },
  WSH: { primary: "#C8102E", secondary: "#041E42" },
  WPG: { primary: "#041E42", secondary: "#004C97" },
};

export const DEFAULT_TEAM_COLORS = { primary: "#334155", secondary: "#94A3B8" };

export function getTeamColors(abbr) {
  return TEAM_COLORS[abbr] || DEFAULT_TEAM_COLORS;
}

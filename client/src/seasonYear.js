// Season 1 is the league's first year with the real NHL rosters: the
// 2026-27 season. Every later season just increments both ends by one —
// this is purely presentational, season_number stays the plain 1/2/3...
// counter everywhere else (DB, phase machinery, ordering).
const FIRST_SEASON_START_YEAR = 2026;

export function seasonYearLabel(seasonNumber) {
  const startYear = FIRST_SEASON_START_YEAR + (seasonNumber - 1);
  const endYear = startYear + 1;
  return `${startYear}-${String(endYear).slice(-2)}`;
}

// The draft for a season happens the spring after it starts — season 1
// (2026-27) drafts in 2027.
export function draftYear(seasonNumber) {
  return FIRST_SEASON_START_YEAR + seasonNumber;
}

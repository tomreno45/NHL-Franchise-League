// Shared by every column-header-click-to-sort table (Stats, Roster).
export function compareValues(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "string") return a.localeCompare(b);
  return a - b;
}

export function sortRows(rows, accessors, sortKey, sortDir) {
  if (!sortKey) return rows;
  const accessor = accessors[sortKey];
  const sign = sortDir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => sign * compareValues(accessor(a), accessor(b)));
}

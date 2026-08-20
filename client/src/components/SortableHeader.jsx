export default function SortableHeader({ label, sortKey, currentKey, direction, onSort, align = "left" }) {
  const isActive = sortKey === currentKey;
  return (
    <th
      onClick={() => onSort(sortKey)}
      className={`cursor-pointer select-none px-3 py-2 font-medium hover:text-slate-200 ${
        align === "right" ? "text-right" : "text-left"
      } ${isActive ? "text-slate-100" : ""}`}
    >
      {label}
      {isActive && <span className="ml-1 text-cyan-400">{direction === "asc" ? "▲" : "▼"}</span>}
    </th>
  );
}

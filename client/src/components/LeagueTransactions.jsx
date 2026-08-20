import { useEffect, useState } from "react";
import { api } from "../api";

const OUTCOME_BADGE = {
  success: "bg-emerald-500/15 text-emerald-400",
  failure: "bg-red-500/15 text-red-400",
};

function formatTimestamp(iso) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function LeagueTransactions() {
  const [transactions, setTransactions] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getLeagueTransactions().then(setTransactions).catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="text-red-500">{error}</p>;
  if (!transactions) return <p className="text-slate-400">Loading league transactions…</p>;

  return (
    <div>
      <p className="mb-4 text-sm text-slate-500">
        Every move across the league — signings, re-signings, and trades — including the ones that fell through.
      </p>
      {transactions.length === 0 ? (
        <p className="text-slate-400">No transactions yet.</p>
      ) : (
        <div className="flex flex-col overflow-hidden rounded-lg bg-slate-900">
          {transactions.map((t) => (
            <div
              key={t.id}
              className={`flex items-start gap-3 border-b border-l-4 border-slate-800 px-4 py-3 text-sm last:border-b-0 ${
                t.outcome === "failure" ? "border-l-red-500" : "border-l-emerald-500"
              }`}
            >
              <span
                className={`mt-0.5 flex-shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                  OUTCOME_BADGE[t.outcome] ?? "bg-slate-700 text-slate-300"
                }`}
              >
                {t.team.abbr}
              </span>
              <div className="flex-1">
                <p className="text-slate-100">{t.message}</p>
                <p className="mt-0.5 text-xs text-slate-500">{formatTimestamp(t.createdAt)}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

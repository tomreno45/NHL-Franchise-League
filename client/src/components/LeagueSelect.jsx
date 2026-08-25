import { useState } from "react";
import { useAuth } from "../AuthContext";

// Shown only for an account that belongs to more than one league —
// credentials are already fully verified by this point (see AuthContext's
// `user.needsLeagueSelection` state, set from server.js's /api/auth/login),
// this is just "which one." Rendered by AuthGate in App.jsx, not nested
// inside Login.jsx, since it's a distinct step with its own back-out
// (logout) rather than part of the credentials form.
export default function LeagueSelect({ account, memberships }) {
  const { selectLeague, logout, openAdminPanel } = useAuth();
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const handleSelect = async (leagueSlug) => {
    setBusy(leagueSlug);
    setError(null);
    try {
      await selectLeague(leagueSlug);
    } catch (err) {
      setError(err.message);
      setBusy(null);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="hub-card w-full max-w-sm rounded-xl p-6">
        <h1 className="mb-1 text-lg font-bold text-slate-100">Welcome back, {account.displayName}</h1>
        <p className="mb-6 hub-label">{memberships.length > 0 ? "Choose a league" : "Choose where to go"}</p>

        <div className="mb-4 flex flex-col gap-2">
          {memberships.map((m) => (
            <button
              key={m.leagueSlug}
              type="button"
              onClick={() => handleSelect(m.leagueSlug)}
              disabled={busy != null}
              className="rounded-md border border-white/10 bg-black/30 px-4 py-3 text-left text-sm font-medium text-slate-200 transition-colors hover:border-cyan-400/60 hover:bg-cyan-400/10 hover:text-cyan-300 disabled:opacity-50"
            >
              {busy === m.leagueSlug ? "Opening…" : m.leagueLabel}
            </button>
          ))}
          {account.isAdmin && (
            <button
              type="button"
              onClick={openAdminPanel}
              disabled={busy != null}
              className="rounded-md border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-left text-sm font-medium text-amber-300 transition-colors hover:border-amber-400/60 hover:bg-amber-400/20 disabled:opacity-50"
            >
              Admin Panel
            </button>
          )}
        </div>

        {error && <p className="mb-4 text-sm text-red-400">{error}</p>}

        <button
          type="button"
          onClick={logout}
          disabled={busy != null}
          className="text-xs text-slate-500 hover:text-slate-300 disabled:opacity-50"
        >
          Not you? Sign out
        </button>
      </div>
    </div>
  );
}

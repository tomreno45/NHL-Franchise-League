import { useState } from "react";
import { useAuth } from "../AuthContext";

// Just credentials — no league picker here anymore. An account now derives
// which league(s) it belongs to from its own memberships (see
// server.js's /api/auth/login): one membership signs straight in, more
// than one hands off to LeagueSelect (rendered by AuthGate in App.jsx)
// instead of asking up front for something most accounts don't need.
export default function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(username, password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={handleSubmit} className="hub-card w-full max-w-sm rounded-xl p-6">
        <h1 className="mb-1 text-lg font-bold text-slate-100">Hockey Franchise League</h1>
        <p className="mb-6 hub-label">Sign in to manage your team</p>

        <label className="mb-1 block text-xs text-slate-400" htmlFor="login-username">
          Username
        </label>
        <input
          id="login-username"
          type="text"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="mb-4 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-slate-100"
        />

        <label className="mb-1 block text-xs text-slate-400" htmlFor="login-password">
          Password
        </label>
        <input
          id="login-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mb-4 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-slate-100"
        />

        {error && <p className="mb-4 text-sm text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={busy || !username || !password}
          className="w-full rounded-md bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign In"}
        </button>
      </form>
    </div>
  );
}

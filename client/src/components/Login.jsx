import { useEffect, useState } from "react";
import { useAuth } from "../AuthContext";
import { api } from "../api";

export default function Login() {
  const { login } = useAuth();
  const [leagues, setLeagues] = useState(null);
  const [league, setLeague] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .getLeagues()
      .then((rows) => {
        setLeagues(rows);
        if (rows.length === 1) setLeague(rows[0].slug);
      })
      .catch((e) => setError(e.message));
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(league, username, password);
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

        <label className="mb-1 block text-xs text-slate-400" htmlFor="login-league">
          League
        </label>
        <div className="mb-4 grid grid-cols-3 gap-2">
          {(leagues || []).map((l) => (
            <button
              key={l.slug}
              type="button"
              onClick={() => setLeague(l.slug)}
              className={`rounded-md border px-2 py-2 text-sm font-medium transition-colors ${
                league === l.slug
                  ? "border-cyan-400/60 bg-cyan-400/10 text-cyan-300"
                  : "border-white/10 bg-black/30 text-slate-400 hover:text-slate-200"
              }`}
            >
              {l.label}
            </button>
          ))}
          {!leagues && <p className="col-span-3 text-sm text-slate-500">Loading leagues…</p>}
        </div>

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
          disabled={busy || !league || !username || !password}
          className="w-full rounded-md bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign In"}
        </button>
      </form>
    </div>
  );
}

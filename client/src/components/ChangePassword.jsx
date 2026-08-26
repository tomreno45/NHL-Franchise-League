import { useState } from "react";
import { useAuth } from "../AuthContext";

// Shown when the account's password was set by someone else (an admin
// resetting it — see accounts.resetPassword) rather than chosen by the
// account holder. Interrupts login before anything else — see AuthGate in
// App.jsx, which checks user.needsPasswordChange ahead of both the Admin
// Panel and needsLeagueSelection. Logging out is the only way out short of
// setting a new password.
export default function ChangePassword({ account }) {
  const { changePassword, logout } = useAuth();
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError("Passwords don't match");
      return;
    }
    setBusy(true);
    try {
      await changePassword(newPassword);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={handleSubmit} className="hub-card w-full max-w-sm rounded-xl p-6">
        <h1 className="mb-1 text-lg font-bold text-slate-100">Set a new password</h1>
        <p className="mb-6 hub-label">
          Welcome back, {account.displayName} — this account's password was reset. Pick a new one to continue.
        </p>

        <label className="mb-1 block text-xs text-slate-400" htmlFor="new-password">
          New password
        </label>
        <input
          id="new-password"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          className="mb-4 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-slate-100"
        />

        <label className="mb-1 block text-xs text-slate-400" htmlFor="confirm-password">
          Confirm new password
        </label>
        <input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className="mb-4 w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 text-sm text-slate-100"
        />

        {error && <p className="mb-4 text-sm text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={busy || !newPassword || !confirmPassword}
          className="mb-3 w-full rounded-md bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Set Password"}
        </button>

        <button
          type="button"
          onClick={logout}
          disabled={busy}
          className="w-full text-xs text-slate-500 hover:text-slate-300 disabled:opacity-50"
        >
          Not you? Sign out
        </button>
      </form>
    </div>
  );
}

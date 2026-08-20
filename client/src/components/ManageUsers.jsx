import { useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../AuthContext";

const ROLE_LABELS = { user: "User", commissioner: "Commissioner" };

const emptyForm = { username: "", password: "", displayName: "", teamId: "", role: "user" };

export default function ManageUsers({ teams }) {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);

  const [form, setForm] = useState(emptyForm);
  const [creating, setCreating] = useState(false);
  const [createMessage, setCreateMessage] = useState(null);

  const [confirmingId, setConfirmingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const reloadUsers = () => api.getUsers().then(setUsers).catch((e) => setError(e.message));

  useEffect(() => {
    reloadUsers();
  }, []);

  // Two clicks, not a native confirm() — a "Remove" click first swaps the
  // row into a "Confirm? / Cancel" state rather than blocking on a browser
  // dialog box, matching this app's existing convention of everything being
  // inline component state (see e.g. every other button in this file).
  const handleConfirmDelete = async (u) => {
    setDeletingId(u.id);
    setError(null);
    setCreateMessage(null);
    try {
      await api.deleteUser(u.id);
      setConfirmingId(null);
      reloadUsers();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeletingId(null);
    }
  };

  const teamLabel = (teamId) => {
    if (teamId == null) return "No team";
    const t = teams.find((t) => t.id === teamId);
    return t ? `${t.city} ${t.name}` : `Team #${teamId}`;
  };

  const setField = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setCreating(true);
    setCreateMessage(null);
    setError(null);
    try {
      const user = await api.createUser({
        username: form.username,
        password: form.password,
        displayName: form.displayName,
        teamId: form.teamId || null,
        role: form.role,
      });
      setCreateMessage(`Created "${user.username}" — share the username and password you just set with them directly.`);
      setForm(emptyForm);
      reloadUsers();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="rounded-lg bg-slate-900 p-5">
      <h3 className="mb-1 text-base font-semibold text-slate-100">Manage Users</h3>
      <p className="mb-4 text-sm text-slate-500">
        Accounts for this league only — Test/Development/Production each have their own. No email or self-serve
        signup; you set the password directly and pass it along to whoever the account is for.
      </p>

      {users && users.length > 0 && (
        <div className="mb-5 overflow-x-auto rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-800 text-left text-slate-400">
                <th className="px-3 py-2 font-medium">Username</th>
                <th className="px-3 py-2 font-medium">Display Name</th>
                <th className="px-3 py-2 font-medium">Team</th>
                <th className="px-3 py-2 font-medium">Role</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u, i) => {
                const isSelf = u.id === currentUser.id;
                return (
                  <tr key={u.id} className={i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/50"}>
                    <td className="px-3 py-2 text-slate-100">
                      {u.username}
                      {isSelf && <span className="ml-2 text-xs text-slate-500">(you)</span>}
                    </td>
                    <td className="px-3 py-2 text-slate-300">{u.displayName}</td>
                    <td className="px-3 py-2 text-slate-300">{teamLabel(u.teamId)}</td>
                    <td className="px-3 py-2 text-slate-300">
                      {u.role === "commissioner" ? (
                        <span className="rounded-full bg-cyan-400/10 px-2 py-0.5 text-xs font-medium text-cyan-300">
                          Commissioner
                        </span>
                      ) : (
                        ROLE_LABELS[u.role] || u.role
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {confirmingId === u.id ? (
                        <span className="inline-flex items-center gap-2">
                          <span className="text-xs text-slate-400">Remove?</span>
                          <button
                            type="button"
                            onClick={() => handleConfirmDelete(u)}
                            disabled={deletingId === u.id}
                            className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
                          >
                            {deletingId === u.id ? "Removing…" : "Confirm"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmingId(null)}
                            disabled={deletingId === u.id}
                            className="rounded-md bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-300 hover:bg-slate-700 disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmingId(u.id)}
                          disabled={isSelf}
                          title={isSelf ? "You can't remove the account you're logged in as" : undefined}
                          className="rounded-md bg-red-950 px-2.5 py-1 text-xs font-medium text-red-300 hover:bg-red-900 disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <form onSubmit={handleSubmit} className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs text-slate-400" htmlFor="new-user-username">
            Username
          </label>
          <input
            id="new-user-username"
            type="text"
            required
            value={form.username}
            onChange={setField("username")}
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-slate-400" htmlFor="new-user-password">
            Password
          </label>
          <input
            id="new-user-password"
            type="text"
            required
            value={form.password}
            onChange={setField("password")}
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-slate-400" htmlFor="new-user-display-name">
            Display Name
          </label>
          <input
            id="new-user-display-name"
            type="text"
            required
            value={form.displayName}
            onChange={setField("displayName")}
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-slate-400" htmlFor="new-user-team">
            Team
          </label>
          <select
            id="new-user-team"
            value={form.teamId}
            onChange={setField("teamId")}
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
          >
            <option value="">No team (commissioner-only account)</option>
            {/* Every team, including CPU-controlled ones — assigning a login
                to a CPU team flips it human-controlled (see store.js's
                createUser), so picking one here is exactly how you hand a
                new GM control of it. */}
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.city} {t.name}
                {!t.isHumanControlled ? " (CPU — becomes human-controlled)" : ""}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-slate-400" htmlFor="new-user-role">
            Role
          </label>
          <select
            id="new-user-role"
            value={form.role}
            onChange={setField("role")}
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
          >
            <option value="user">User</option>
            <option value="commissioner">Commissioner</option>
          </select>
        </div>
        <div className="flex items-end">
          <button
            type="submit"
            disabled={creating}
            className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {creating ? "Creating…" : "Create Account"}
          </button>
        </div>
      </form>

      {createMessage && <p className="mt-3 text-sm text-emerald-400">{createMessage}</p>}
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
    </div>
  );
}

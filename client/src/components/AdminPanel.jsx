import { useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../AuthContext";

const ROLE_LABELS = { user: "User", commissioner: "Commissioner" };

function teamLabel(teams, teamId) {
  if (teamId == null) return "No team";
  const t = teams?.find((t) => t.id === teamId);
  return t ? `${t.city} ${t.name}` : `Team #${teamId}`;
}

function AddMembershipForm({ account, leagues, teamsByLeague, onAdd }) {
  const [leagueSlug, setLeagueSlug] = useState(leagues[0]?.slug || "");
  const [teamId, setTeamId] = useState("");
  const [role, setRole] = useState("user");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const alreadyIn = new Set(account.memberships.map((m) => m.leagueSlug));
  const availableLeagues = leagues.filter((l) => !alreadyIn.has(l.slug));
  if (availableLeagues.length === 0) return null;

  const teams = teamsByLeague[leagueSlug] || [];

  const handleAdd = async () => {
    setBusy(true);
    setError(null);
    try {
      await onAdd({ leagueSlug: leagueSlug || availableLeagues[0].slug, teamId: teamId || null, role });
      setTeamId("");
      setRole("user");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-slate-950 p-2">
      <select
        value={leagueSlug || availableLeagues[0].slug}
        onChange={(e) => {
          setLeagueSlug(e.target.value);
          setTeamId("");
        }}
        className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100"
      >
        {availableLeagues.map((l) => (
          <option key={l.slug} value={l.slug}>
            {l.label}
          </option>
        ))}
      </select>
      <select
        value={teamId}
        onChange={(e) => setTeamId(e.target.value)}
        className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100"
      >
        <option value="">No team</option>
        {teams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.city} {t.name}
            {!t.isHumanControlled ? " (CPU)" : ""}
          </option>
        ))}
      </select>
      <select
        value={role}
        onChange={(e) => setRole(e.target.value)}
        className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100"
      >
        <option value="user">User</option>
        <option value="commissioner">Commissioner</option>
      </select>
      <button
        type="button"
        onClick={handleAdd}
        disabled={busy}
        className="rounded-md bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
      >
        {busy ? "Adding…" : "Add to League"}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}

function AccountRow({ account, leagues, teamsByLeague, onChanged }) {
  const [removingSlug, setRemovingSlug] = useState(null);
  const [confirmingRemove, setConfirmingRemove] = useState(null);
  const [resetting, setResetting] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [resetMessage, setResetMessage] = useState(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);

  const membershipByLeague = new Map(account.memberships.map((m) => [m.leagueSlug, m]));

  const handleAddMembership = async (payload) => {
    await api.adminAddMembership(account.id, payload);
    onChanged();
  };

  const handleRemove = async (membershipId, leagueSlug) => {
    setRemovingSlug(leagueSlug);
    setError(null);
    try {
      await api.adminRemoveMembership(membershipId);
      setConfirmingRemove(null);
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setRemovingSlug(null);
    }
  };

  const handleResetPassword = async () => {
    setResetting(true);
    setResetMessage(null);
    setError(null);
    try {
      await api.adminResetPassword(account.id, newPassword);
      setResetMessage("Password reset — share it with them directly.");
      setNewPassword("");
    } catch (err) {
      setError(err.message);
    } finally {
      setResetting(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    setError(null);
    try {
      await api.adminDeleteAccount(account.id);
      onChanged();
    } catch (err) {
      setError(err.message);
      setDeleting(false);
    }
  };

  return (
    <div className="rounded-lg bg-slate-900 p-4">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <span className="font-semibold text-slate-100">{account.username}</span>{" "}
          <span className="text-sm text-slate-400">{account.displayName}</span>
          {account.isAdmin && (
            <span className="ml-2 rounded-full bg-amber-400/10 px-2 py-0.5 text-xs font-medium text-amber-300">
              Admin
            </span>
          )}
        </div>
        {confirmingDelete ? (
          <span className="inline-flex shrink-0 items-center gap-2">
            <span className="text-xs text-slate-400">Delete permanently?</span>
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
            >
              {deleting ? "Deleting…" : "Confirm"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              disabled={deleting}
              className="rounded-md bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-300 hover:bg-slate-700 disabled:opacity-50"
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            className="shrink-0 rounded-md bg-red-950 px-2.5 py-1 text-xs font-medium text-red-300 hover:bg-red-900"
          >
            Delete Account
          </button>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        {leagues
          .filter((l) => membershipByLeague.has(l.slug))
          .map((l) => {
            const m = membershipByLeague.get(l.slug);
            return (
              <div key={l.slug} className="flex items-center justify-between rounded-md bg-slate-950 px-3 py-1.5 text-sm">
                <span className="text-slate-300">
                  <span className="font-medium text-slate-100">{l.label}</span> —{" "}
                  {teamLabel(teamsByLeague[l.slug], m.teamId)} — {ROLE_LABELS[m.role] || m.role}
                </span>
                {confirmingRemove === l.slug ? (
                  <span className="inline-flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleRemove(m.id, l.slug)}
                      disabled={removingSlug === l.slug}
                      className="rounded-md bg-red-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
                    >
                      {removingSlug === l.slug ? "…" : "Confirm"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingRemove(null)}
                      className="rounded-md bg-slate-800 px-2 py-0.5 text-xs font-medium text-slate-300 hover:bg-slate-700"
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmingRemove(l.slug)}
                    className="rounded-md bg-slate-800 px-2 py-0.5 text-xs font-medium text-slate-400 hover:bg-slate-700 hover:text-slate-200"
                  >
                    Remove
                  </button>
                )}
              </div>
            );
          })}
        {account.memberships.length === 0 && <p className="text-sm text-slate-600">Not in any league.</p>}
      </div>

      <AddMembershipForm account={account} leagues={leagues} teamsByLeague={teamsByLeague} onAdd={handleAddMembership} />

      <div className="mt-3 flex items-center gap-2 border-t border-white/5 pt-3">
        {resetting ? (
          <>
            <input
              type="text"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="New password"
              className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
            />
            <button
              type="button"
              onClick={handleResetPassword}
              disabled={!newPassword}
              className="rounded-md bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            >
              Set
            </button>
            <button
              type="button"
              onClick={() => {
                setResetting(false);
                setNewPassword("");
              }}
              className="text-xs text-slate-500 hover:text-slate-300"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setResetting(true)}
            className="text-xs text-slate-500 hover:text-slate-300"
          >
            Reset Password
          </button>
        )}
        {resetMessage && <span className="text-xs text-emerald-400">{resetMessage}</span>}
      </div>

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}

export default function AdminPanel() {
  const { user, closeAdminPanel, logout } = useAuth();
  const [leagues, setLeagues] = useState(null);
  const [teamsByLeague, setTeamsByLeague] = useState({});
  const [accounts, setAccounts] = useState(null);
  const [error, setError] = useState(null);

  const [form, setForm] = useState({ username: "", password: "", displayName: "" });
  const [creating, setCreating] = useState(false);
  const [createMessage, setCreateMessage] = useState(null);

  const reloadAccounts = () => api.adminGetAccounts().then(setAccounts).catch((e) => setError(e.message));

  useEffect(() => {
    api
      .getLeagues()
      .then(async (rows) => {
        setLeagues(rows);
        const entries = await Promise.all(rows.map(async (l) => [l.slug, await api.adminGetTeams(l.slug)]));
        setTeamsByLeague(Object.fromEntries(entries));
      })
      .catch((e) => setError(e.message));
    reloadAccounts();
  }, []);

  const setField = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const handleCreate = async (e) => {
    e.preventDefault();
    setCreating(true);
    setCreateMessage(null);
    setError(null);
    try {
      const account = await api.adminCreateAccount(form);
      setCreateMessage(`Created "${account.username}" — add them to a league below, and share the password directly.`);
      setForm({ username: "", password: "", displayName: "" });
      reloadAccounts();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const canExit = Boolean(user.league || (user.memberships && user.memberships.length > 0));

  return (
    <div className="min-h-screen px-4 py-6 sm:px-6">
      <div className="mx-auto flex max-w-4xl flex-col gap-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-slate-100">Admin Panel</h1>
            <p className="hub-label">Every account, every league</p>
          </div>
          <div className="flex items-center gap-3">
            {canExit && (
              <button
                type="button"
                onClick={closeAdminPanel}
                className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-400 hover:border-slate-600 hover:text-slate-200"
              >
                ← Back
              </button>
            )}
            <button
              type="button"
              onClick={logout}
              className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-400 hover:border-slate-600 hover:text-slate-200"
            >
              Log Out
            </button>
          </div>
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <div className="rounded-lg bg-slate-900 p-5">
          <h2 className="mb-1 text-base font-semibold text-slate-100">Create New Account</h2>
          <p className="mb-3 text-sm text-slate-500">
            Just the account — add it to a league from the list below afterward.
          </p>
          <form onSubmit={handleCreate} className="grid gap-3 sm:grid-cols-4">
            <input
              type="text"
              required
              placeholder="Username"
              value={form.username}
              onChange={setField("username")}
              className="rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
            />
            <input
              type="text"
              required
              placeholder="Password"
              value={form.password}
              onChange={setField("password")}
              className="rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
            />
            <input
              type="text"
              required
              placeholder="Display Name"
              value={form.displayName}
              onChange={setField("displayName")}
              className="rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100"
            />
            <button
              type="submit"
              disabled={creating}
              className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            >
              {creating ? "Creating…" : "Create Account"}
            </button>
          </form>
          {createMessage && <p className="mt-3 text-sm text-emerald-400">{createMessage}</p>}
        </div>

        {!accounts || !leagues ? (
          <p className="text-slate-400">Loading accounts…</p>
        ) : (
          <div className="flex flex-col gap-3">
            {accounts.map((account) => (
              <AccountRow
                key={account.id}
                account={account}
                leagues={leagues}
                teamsByLeague={teamsByLeague}
                onChanged={reloadAccounts}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

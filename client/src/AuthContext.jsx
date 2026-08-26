import { createContext, useContext, useEffect, useState } from "react";
import { api } from "./api";

const AuthContext = createContext(null);

// `user` is `undefined` while the initial /auth/me check is in flight,
// `null` once confirmed logged-out, `{needsPasswordChange: true, account}`
// once credentials are verified but the account is carrying a password
// someone else picked for it (see accounts.resetPassword) and hasn't
// replaced it yet, `{needsLeagueSelection: true, account, memberships}`
// once past that but a multi-league (or admin) account still hasn't picked
// which league to open, or the full user object once fully logged in —
// AuthGate in App.jsx branches on all five states, checking
// needsPasswordChange before anything else. `adminPanelOpen` is separate,
// client-only UI state (not part of the session) — an admin account can
// toggle into/out of the Admin Panel at any point after credentials are
// verified, regardless of which of the above states `user` is in.
export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined);
  const [adminPanelOpen, setAdminPanelOpen] = useState(false);

  const refresh = () => {
    api
      .getMe()
      .then(setUser)
      .catch(() => setUser(null));
  };

  useEffect(refresh, []);

  const login = async (username, password) => {
    const result = await api.login(username, password);
    setUser(result);
  };

  // Finishes a login that returned needsPasswordChange — the response is
  // the exact same shape login() itself would return (needsLeagueSelection
  // or a full user), so setUser here naturally carries the account to
  // whichever screen comes next.
  const changePassword = async (newPassword) => {
    const result = await api.changePassword(newPassword);
    setUser(result);
  };

  // Finishes a login that returned needsLeagueSelection, or switches an
  // already-fully-logged-in session to a different one of the account's
  // leagues — same call either way (see server.js's /api/auth/select-league).
  const selectLeague = async (leagueSlug) => {
    const loggedInUser = await api.selectLeague(leagueSlug);
    setUser(loggedInUser);
    setAdminPanelOpen(false);
  };

  const logout = async () => {
    await api.logout();
    setUser(null);
    setAdminPanelOpen(false);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        login,
        changePassword,
        selectLeague,
        logout,
        refresh,
        adminPanelOpen,
        openAdminPanel: () => setAdminPanelOpen(true),
        closeAdminPanel: () => setAdminPanelOpen(false),
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

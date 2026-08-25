import { createContext, useContext, useEffect, useState } from "react";
import { api } from "./api";

const AuthContext = createContext(null);

// `user` is `undefined` while the initial /auth/me check is in flight,
// `null` once confirmed logged-out, `{needsLeagueSelection: true, account,
// memberships}` once credentials are verified but a multi-league account
// hasn't picked which league to open yet, or the full user object once
// fully logged in — AppShell in App.jsx branches on all four states.
export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined);

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

  // Finishes a login that returned needsLeagueSelection, or switches an
  // already-fully-logged-in session to a different one of the account's
  // leagues — same call either way (see server.js's /api/auth/select-league).
  const selectLeague = async (leagueSlug) => {
    const loggedInUser = await api.selectLeague(leagueSlug);
    setUser(loggedInUser);
  };

  const logout = async () => {
    await api.logout();
    setUser(null);
  };

  return <AuthContext.Provider value={{ user, login, selectLeague, logout, refresh }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

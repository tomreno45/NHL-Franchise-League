import { createContext, useContext, useEffect, useState } from "react";
import { api } from "./api";

const AuthContext = createContext(null);

// `user` is `undefined` while the initial /auth/me check is in flight,
// `null` once confirmed logged-out, or the user object once logged in —
// AppShell in App.jsx branches on all three states (loading / Login / app).
export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined);

  const refresh = () => {
    api
      .getMe()
      .then(setUser)
      .catch(() => setUser(null));
  };

  useEffect(refresh, []);

  const login = async (league, username, password) => {
    const loggedInUser = await api.login(league, username, password);
    setUser(loggedInUser);
  };

  const logout = async () => {
    await api.logout();
    setUser(null);
  };

  return <AuthContext.Provider value={{ user, login, logout, refresh }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

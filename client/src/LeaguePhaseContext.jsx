import { createContext, useContext, useEffect, useState } from "react";
import { api } from "./api";

const LeaguePhaseContext = createContext(null);

export function LeaguePhaseProvider({ children }) {
  const [phase, setPhase] = useState(null);
  const [error, setError] = useState(null);

  const reload = () => {
    api.getLeaguePhase().then(setPhase).catch((e) => setError(e.message));
  };

  useEffect(() => {
    reload();
  }, []);

  return (
    <LeaguePhaseContext.Provider value={{ phase, error, reload, setPhase }}>{children}</LeaguePhaseContext.Provider>
  );
}

export function useLeaguePhase() {
  return useContext(LeaguePhaseContext);
}

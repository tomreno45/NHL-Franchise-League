import { createContext, useContext, useEffect, useState } from "react";
import { api } from "./api";
import { useAuth } from "./AuthContext";

const MyTeamContext = createContext(null);

// Which human-controlled team the current user is GM of — derived directly
// from the authenticated session (see AuthContext), not a client-side
// picker or localStorage. `teams` (every human-controlled team, not just
// yours) is still fetched and exposed since several screens need to list or
// target every human team — e.g. Trade Center's opponent picker.
export function MyTeamProvider({ children }) {
  const { user } = useAuth();
  const [teams, setTeams] = useState([]);

  useEffect(() => {
    api.getTeams().then((all) => setTeams(all.filter((t) => t.isHumanControlled)));
  }, []);

  const myTeamId = user?.teamId ?? null;

  return <MyTeamContext.Provider value={{ teams, myTeamId }}>{children}</MyTeamContext.Provider>;
}

export function useMyTeam() {
  const ctx = useContext(MyTeamContext);
  if (!ctx) throw new Error("useMyTeam must be used within MyTeamProvider");
  return ctx;
}

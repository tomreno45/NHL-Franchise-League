import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api } from "./api";
import { useMyTeam } from "./MyTeamContext";

const NotificationsContext = createContext(null);

// Polls the unread count so the nav badge stays current without every
// component that changes notifications having to know who else needs to
// hear about it — free agency/re-signing/trade resolution all happen behind
// "Advance Phase," not through this component tree.
const POLL_MS = 15000;

export function NotificationsProvider({ children }) {
  const { myTeamId } = useMyTeam();
  const [unreadCount, setUnreadCount] = useState(0);

  const refresh = useCallback(() => {
    if (myTeamId == null) return;
    api
      .getUnreadNotificationCount(myTeamId)
      .then((r) => setUnreadCount(r.count))
      .catch(() => {});
  }, [myTeamId]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  return <NotificationsContext.Provider value={{ unreadCount, refresh }}>{children}</NotificationsContext.Provider>;
}

export function useNotifications() {
  return useContext(NotificationsContext);
}

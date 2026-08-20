import { useEffect, useState } from "react";
import { api } from "../api";
import { useMyTeam } from "../MyTeamContext";
import { useNotifications } from "../NotificationsContext";

function formatTimestamp(iso) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function Notifications() {
  const { myTeamId } = useMyTeam();
  const { refresh: refreshUnreadCount } = useNotifications();
  const [notifications, setNotifications] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (myTeamId == null) return;
    api
      .getNotifications(myTeamId)
      .then((list) => {
        setNotifications(list);
        if (list.some((n) => !n.read)) {
          api
            .markNotificationsRead(myTeamId)
            .then(refreshUnreadCount)
            .catch(() => {});
        }
      })
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myTeamId]);

  if (error) return <p className="text-red-500">{error}</p>;
  if (myTeamId == null || !notifications) return <p className="text-slate-400">Loading notifications…</p>;

  return (
    <div>
      {notifications.length === 0 ? (
        <p className="text-sm text-slate-500">No notifications yet — this fills up once offers and trades resolve.</p>
      ) : (
        <div className="flex flex-col overflow-hidden rounded-lg bg-slate-900">
          {notifications.map((n) => (
            <div
              key={n.id}
              className={`flex items-start gap-3 border-b border-l-4 border-slate-800 px-4 py-3 text-sm last:border-b-0 ${
                n.outcome === "failure" ? "border-l-red-500" : "border-l-emerald-500"
              } ${n.read ? "" : "bg-sky-500/5"}`}
            >
              {!n.read && <span className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-sky-500" />}
              <div className={n.read ? "ml-5 flex-1" : "flex-1"}>
                <p className="text-slate-100">{n.message}</p>
                <p className="mt-0.5 text-xs text-slate-500">{formatTimestamp(n.createdAt)}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

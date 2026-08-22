import { useEffect, useState } from "react";
import { api } from "../api";
import { useMyTeam } from "../MyTeamContext";
import { useNotifications } from "../NotificationsContext";
import { getCurrentSubscription, isPushSupported, subscribeToPush, unsubscribeFromPush } from "../push";

function formatTimestamp(iso) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Push on/off lives here (not in the account menu) since this is where a GM
// actually reads notifications — the toggle for whether new ones show up as
// a push belongs right above the list they'd otherwise only see in-app.
function PushToggle() {
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!isPushSupported()) return;
    getCurrentSubscription()
      .then((sub) => setSubscribed(Boolean(sub)))
      .catch(() => {});
  }, []);

  if (!isPushSupported()) return null;

  const handleToggle = async () => {
    setBusy(true);
    setError(null);
    try {
      if (subscribed) {
        await unsubscribeFromPush();
        setSubscribed(false);
      } else {
        await subscribeToPush();
        setSubscribed(true);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-4 flex items-center gap-3 rounded-lg bg-slate-900 px-4 py-3">
      <span className="text-sm text-slate-300">
        Push notifications are{" "}
        <span className={subscribed ? "font-semibold text-emerald-400" : "font-semibold text-slate-500"}>
          {subscribed ? "ON" : "OFF"}
        </span>{" "}
        for this browser
      </span>
      <button
        type="button"
        onClick={handleToggle}
        disabled={busy}
        className={`ml-auto rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${
          subscribed
            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:border-emerald-500/50"
            : "border-slate-700 text-slate-400 hover:border-slate-600 hover:text-slate-200"
        }`}
      >
        {busy ? "…" : subscribed ? "Turn Off" : "Turn On"}
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
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

  if (error) {
    return (
      <div>
        <PushToggle />
        <p className="text-red-500">{error}</p>
      </div>
    );
  }
  if (myTeamId == null || !notifications) {
    return (
      <div>
        <PushToggle />
        <p className="text-slate-400">Loading notifications…</p>
      </div>
    );
  }

  return (
    <div>
      <PushToggle />
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

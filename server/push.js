// Web Push delivery — separate from store.js because this is a "how to
// deliver" concern (talks to browsers' push services over the network),
// not app business logic. store.js/server.js call into this at the points
// that should actually notify someone; this module doesn't decide when
// that is.
const webpush = require("web-push");
const { pool } = require("./db");

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT;

// Push is opt-in infrastructure, not a hard requirement to run the app —
// every call below is a no-op (rather than a thrown error) when the keys
// aren't set, so a deploy that hasn't configured push yet just silently
// doesn't send any, instead of every trade offer/phase advance failing.
const configured = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT);
if (configured) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

async function saveSubscription(userId, subscription) {
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]
  );
}

async function removeSubscription(endpoint) {
  await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [endpoint]);
}

// Fires one push per subscription row and swallows per-row failures — a
// dead subscription (410/404, the push service's own "this endpoint is
// gone" signal) gets cleaned up automatically; anything else (a network
// blip, a transient 5xx from the push service) is logged and otherwise
// ignored, since a failed push should never break the trade offer/phase
// advance/etc. that triggered it — the in-app notification already covers
// delivery regardless of whether the push itself lands.
async function sendToRows(rows, payload) {
  if (!configured || rows.length === 0) return;
  const body = JSON.stringify(payload);
  await Promise.all(
    rows.map(async (row) => {
      try {
        await webpush.sendNotification({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, body);
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await removeSubscription(row.endpoint);
        } else {
          console.error("Push send failed:", err.statusCode ?? err.message);
        }
      }
    })
  );
}

async function sendToAllUsers(payload) {
  if (!configured) return;
  const { rows } = await pool.query("SELECT endpoint, p256dh, auth FROM push_subscriptions");
  await sendToRows(rows, payload);
}

// Every login currently assigned to teamId — same "a team's account(s)"
// join every other team-scoped query in this app already does via
// users.team_id, just read-only here.
async function sendToTeam(teamId, payload) {
  if (!configured) return;
  const { rows } = await pool.query(
    `SELECT s.endpoint, s.p256dh, s.auth FROM push_subscriptions s
     JOIN users u ON u.id = s.user_id WHERE u.team_id = $1`,
    [teamId]
  );
  await sendToRows(rows, payload);
}

module.exports = {
  configured,
  publicKey: VAPID_PUBLIC_KEY,
  saveSubscription,
  removeSubscription,
  sendToAllUsers,
  sendToTeam,
};

// Web Push delivery — separate from store.js because this is a "how to
// deliver" concern (talks to browsers' push services over the network),
// not app business logic. store.js/server.js call into this at the points
// that should actually notify someone; this module doesn't decide when
// that is.
//
// Talks to sessionPool (the shared/global database), not the league-routed
// pool from db.js — push_subscriptions is keyed by accountId now (global
// login identity, see accounts.js), not by a per-league users.id. A send is
// still scoped to one league exactly like before (an account's push
// subscription fires only for events in whichever league is currently
// active), via a join through account_memberships filtered by
// getActiveLeagueSlug() — the same AsyncLocalStorage lookup db.js's
// activePool() already relies on, just exposed directly so store.js's
// trade-offer/phase-advance call sites don't need to change at all.
const webpush = require("web-push");
const { sessionPool, getActiveLeagueSlug } = require("./db");

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

async function saveSubscription(accountId, subscription) {
  await sessionPool.query(
    `INSERT INTO push_subscriptions (account_id, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET account_id = EXCLUDED.account_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [accountId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]
  );
}

async function removeSubscription(endpoint) {
  await sessionPool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [endpoint]);
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

// "All users" has always actually meant "everyone subscribed in the
// currently active league" (it read from that league's own
// push_subscriptions table before this table became shared) — preserved
// exactly via the league_slug filter, not broadened into a genuine
// all-leagues broadcast.
async function sendToAllUsers(payload) {
  if (!configured) return;
  const leagueSlug = getActiveLeagueSlug();
  if (!leagueSlug) return;
  const { rows } = await sessionPool.query(
    `SELECT s.endpoint, s.p256dh, s.auth FROM push_subscriptions s
     JOIN account_memberships m ON m.account_id = s.account_id
     WHERE m.league_slug = $1`,
    [leagueSlug]
  );
  await sendToRows(rows, payload);
}

// Every login currently assigned to teamId, scoped to the currently active
// league — same "a team's account(s)" join every other team-scoped query in
// this app already does, just against the global membership table instead
// of a per-league users.team_id column.
async function sendToTeam(teamId, payload) {
  if (!configured) return;
  const leagueSlug = getActiveLeagueSlug();
  if (!leagueSlug) return;
  const { rows } = await sessionPool.query(
    `SELECT s.endpoint, s.p256dh, s.auth FROM push_subscriptions s
     JOIN account_memberships m ON m.account_id = s.account_id
     WHERE m.league_slug = $1 AND m.team_id = $2`,
    [leagueSlug, teamId]
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

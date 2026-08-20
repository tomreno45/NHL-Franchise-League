const BASE = "/api";

// credentials: "include" is a no-op today (Vite's dev proxy makes every
// request same-origin from the browser's point of view) but becomes
// load-bearing the moment client and server are deployed on separate
// origins — the session cookie won't be sent cross-origin without it.
async function get(path) {
  const res = await fetch(`${BASE}${path}`, { credentials: "include" });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `Request failed: ${path} (${res.status})`);
  }
  return res.json();
}

async function send(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error || `Request failed: ${path} (${res.status})`);
  }
  return res.json();
}

export const api = {
  getLeagues: () => get("/leagues"),
  login: (league, username, password) => send("POST", "/auth/login", { league, username, password }),
  logout: () => send("POST", "/auth/logout", {}),
  getMe: () => get("/auth/me"),
  getStandings: () => get("/standings"),
  getTeams: () => get("/teams"),
  getRoster: (teamId) => get(`/teams/${teamId}/roster`),
  getTeamCap: (teamId) => get(`/teams/${teamId}/cap`),
  getTeamNeeds: (teamId) => get(`/teams/${teamId}/needs`),
  getSchedule: (teamId) => get(`/schedule${teamId ? `?teamId=${teamId}` : ""}`),
  getScorers: (teamId) => get(`/scorers${teamId ? `?teamId=${teamId}` : ""}`),
  getGoalieLeaders: (teamId) => get(`/goalies${teamId ? `?teamId=${teamId}` : ""}`),
  getPendingGames: () => get("/games/pending"),
  submitScore: (gameId, payload) => send("PUT", `/games/${gameId}/score`, payload),
  advanceSimulation: () => send("POST", "/sim/advance", {}),
  simulateAllRemainingGames: () => send("POST", "/sim/advance-all", {}),
  runProgression: () => send("POST", "/progression/run", {}),
  getLatestProgression: () => get("/progression/latest"),
  getSeason: () => get("/season"),
  getLeaguePhase: () => get("/league/phase"),
  advancePhase: () => send("POST", "/league/phase/advance", {}),
  getFreeAgencyBoard: (teamId) => get(`/freeagency/board${teamId ? `?teamId=${teamId}` : ""}`),
  submitFreeAgentBid: (payload) => send("POST", "/freeagency/bids", payload),
  getResigningBoard: () => get("/resigning/board"),
  submitResignOffer: (payload) => send("POST", "/resigning/offers", payload),
  getTradeProposals: (teamId) => get(`/traderounds/proposals${teamId ? `?teamId=${teamId}` : ""}`),
  submitTradeProposal: (payload) => send("POST", "/traderounds/proposals", payload),
  getCpuTradeOffers: () => get("/traderounds/cpu-offers"),
  respondToCpuTradeOffer: (offerId, accept) => send("POST", `/traderounds/cpu-offers/${offerId}/respond`, { accept }),
  getPendingMoves: (teamId) => get(`/mygm/pending-moves?teamId=${teamId}`),
  getNotifications: (teamId) => get(`/mygm/notifications?teamId=${teamId}`),
  getUnreadNotificationCount: (teamId) => get(`/mygm/notifications/unread-count?teamId=${teamId}`),
  markNotificationsRead: (teamId) => send("POST", "/mygm/notifications/read", { teamId }),
  getLeagueTransactions: () => get("/league/transactions"),
  advanceLeagueDate: (days) => send("POST", "/league/advance-date", { days }),
  getLineupSlots: () => get("/lineup/slots"),
  assignLineupSlot: (payload) => send("POST", "/lineup/assign", payload),
  getRosterChanges: () => get("/commissioner/roster-changes"),
  getUsers: () => get("/users"),
  createUser: (payload) => send("POST", "/commissioner/users", payload),
  deleteUser: (id) => send("DELETE", `/commissioner/users/${id}`, {}),
  setPlayoffChampion: (teamId) => send("POST", "/playoffs/champion", { teamId }),
  getPlayoffResults: () => get("/playoffs/results"),
  getDraftPicks: (teamId) => get(`/draft/picks${teamId ? `?teamId=${teamId}` : ""}`),
  getDraftOrder: () => get("/draft/order"),
  setDraftOrder: (teamIds) => send("POST", "/draft/order", { teamIds }),
  getDraftClass: () => get("/draft/class"),
  generateDraftClass: () => send("POST", "/draft/class/generate", {}),
  importDraftClass: (csvText) => send("POST", "/draft/class/import", { csvText }),
  getDraftStatus: () => get("/draft/status"),
  advanceDraft: () => send("POST", "/draft/advance", {}),
  makeDraftPick: (payload) => send("POST", "/draft/pick", payload),
  evaluateTrade: (payload) => send("POST", "/trades/evaluate", payload),
  executeTrade: (payload) => send("POST", "/trades/execute", payload),
};

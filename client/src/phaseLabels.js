export const PHASE_LABELS = {
  free_agency: "Free Agency",
  trade_period: "Trade Period",
  set_roster: "Set Roster",
  roster_update: "Roster Update (Commissioner)",
  regular_season: "Regular Season",
  playoffs: "Playoffs",
  post_playoff_trade: "Post-Playoff Trade Round",
  draft: "Draft",
  progression: "Progression",
  resigning: "Re-signing",
};

// Same order as server.js's PHASE_SEQUENCE (that file is the source of
// truth for what actually happens on advance; this is just for rendering
// the flow client-side without another round trip).
export const PHASE_ORDER = Object.keys(PHASE_LABELS);

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY,
  city TEXT NOT NULL,
  name TEXT NOT NULL,
  abbr TEXT NOT NULL,
  conference TEXT NOT NULL,
  division TEXT NOT NULL,
  is_human_controlled BOOLEAN NOT NULL
);

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY,
  team_id INTEGER REFERENCES teams(id),
  name TEXT NOT NULL,
  position TEXT NOT NULL,
  jersey_number INTEGER NOT NULL,
  age INTEGER NOT NULL,
  overall INTEGER NOT NULL,
  cap_hit NUMERIC(5, 2) NOT NULL,
  contract_years_left INTEGER NOT NULL,
  in_game_status TEXT NOT NULL,
  attributes JSONB NOT NULL,
  potential JSONB NOT NULL,
  stats JSONB NOT NULL
);

ALTER TABLE players ADD COLUMN IF NOT EXISTS potential JSONB;

-- An unsigned free agent is just a players row with team_id NULL — full
-- real stats/attributes, not a separate table like draft prospects (which
-- are hidden-until-drafted and never real players until picked). Relaxing
-- an existing NOT NULL constraint is idempotent: re-running this on an
-- already-nullable column is a no-op, so it's safe on every startup.
ALTER TABLE players ALTER COLUMN team_id DROP NOT NULL;

-- One of 20 unique line-editor slots (F1_LW..F4_RW, D1_L..D3_R, G1/G2),
-- 'SCRATCH' (dressed but sitting out, capped at 5), or 'MINORS' (default —
-- doesn't need an NHL 27 card, can't be called up mid season). See
-- store.js's LINEUP_SLOTS/assignLineupSlot. Persists across seasons until
-- explicitly changed again; there's no automatic reset.
ALTER TABLE players ADD COLUMN IF NOT EXISTS roster_assignment TEXT NOT NULL DEFAULT 'MINORS';
UPDATE players SET roster_assignment = 'MINORS' WHERE roster_assignment = 'active';
ALTER TABLE players ALTER COLUMN roster_assignment SET DEFAULT 'MINORS';

CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY,
  date DATE NOT NULL,
  home_team_id INTEGER NOT NULL REFERENCES teams(id),
  away_team_id INTEGER NOT NULL REFERENCES teams(id),
  status TEXT NOT NULL,
  home_score INTEGER,
  away_score INTEGER,
  went_to_ot BOOLEAN NOT NULL DEFAULT false,
  source TEXT
);

-- The full per-player stat line behind a manually-reported human_vs_human
-- score: { wentToOT, home: { goalieId, shotsFaced, skaters: [{playerId,
-- goals, assists}] }, away: {...} }. Stored (not just applied to players)
-- so a correction can cleanly reverse the previous submission's stat
-- contributions before applying the new one — see store.js's submitScore.
-- NULL for CPU-simmed games and any human game scored before this column
-- existed (those just have a final score with no individual attribution).
ALTER TABLE games ADD COLUMN IF NOT EXISTS box_score JSONB;

-- Singleton row (id always 1) holding the league's own clock and season counter.
CREATE TABLE IF NOT EXISTS league_state (
  id INTEGER PRIMARY KEY DEFAULT 1,
  season_number INTEGER NOT NULL,
  league_date DATE NOT NULL,
  next_game_id INTEGER NOT NULL,
  CONSTRAINT single_row CHECK (id = 1)
);

-- Where the league currently sits in the season phase pipeline (see
-- store.js's PHASE_SEQUENCE). Defaults preserve today's existing/legacy
-- database's behavior — it's mid-regular-season already — while a phase
-- default this basic still lets a brand new seed start somewhere sane until
-- a real "new franchise" flow picks a more deliberate starting phase later.
ALTER TABLE league_state ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'regular_season';
ALTER TABLE league_state ADD COLUMN IF NOT EXISTS phase_round INTEGER NOT NULL DEFAULT 1;

-- Index into the current season's draft picks, ordered by overall pick
-- number, tracking whose turn it is. Reset to 0 when the draft phase is
-- entered — see advanceLeaguePhase's phase-transition branch in store.js.
ALTER TABLE league_state ADD COLUMN IF NOT EXISTS current_pick_index INTEGER NOT NULL DEFAULT 0;

-- A human-controlled team marking itself done with the current phase/round
-- checkpoint — see store.js's setTeamReady/getReadyStatus. A row's mere
-- presence means "ready"; there's no boolean column since un-readying just
-- deletes the row. Naturally scoped to one specific checkpoint by the
-- primary key, so advancing to a new phase/round starts everyone unready
-- again without any extra reset step — the old checkpoint's rows just
-- become orphaned (and get cleaned up explicitly once everyone's advanced
-- past them, see setTeamReady) rather than needing to carry forward.
CREATE TABLE IF NOT EXISTS phase_ready_teams (
  season_number INTEGER NOT NULL,
  phase TEXT NOT NULL,
  phase_round INTEGER NOT NULL,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  PRIMARY KEY (season_number, phase, phase_round, team_id)
);

CREATE TABLE IF NOT EXISTS progression_runs (
  id SERIAL PRIMARY KEY,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  total_players_progressed INTEGER NOT NULL,
  total_flagged INTEGER NOT NULL,
  change_sheets JSONB NOT NULL
);

-- Each row is one pick asset (a specific team's selection in a specific
-- round of a specific season's draft). original_team_id never changes —
-- it's whose place in the draft order this pick represents, which is what
-- determines its value. current_team_id changes when the pick is traded.
CREATE TABLE IF NOT EXISTS draft_picks (
  id SERIAL PRIMARY KEY,
  season_number INTEGER NOT NULL,
  round INTEGER NOT NULL,
  original_team_id INTEGER NOT NULL REFERENCES teams(id),
  current_team_id INTEGER NOT NULL REFERENCES teams(id)
);

-- One draft-eligible 18-year-old prospect. Full hidden attributes/potential
-- are stored (so a future "select prospect" step can convert a row directly
-- into a real players row) but the public draft board only ever reads
-- name/position/nationality/height/weight/prospect_rank — overall and
-- potential never leave the server. prospect_rank is rolled once at
-- generation/import time and persisted, not recomputed on read, since a
-- draft board that reshuffled itself on every page load would be useless.
CREATE TABLE IF NOT EXISTS draft_prospects (
  id SERIAL PRIMARY KEY,
  season_number INTEGER NOT NULL,
  name TEXT NOT NULL,
  position TEXT NOT NULL,
  nationality TEXT NOT NULL,
  height_inches INTEGER NOT NULL,
  weight_lbs INTEGER NOT NULL,
  age INTEGER NOT NULL DEFAULT 18,
  overall INTEGER NOT NULL,
  attributes JSONB NOT NULL,
  potential JSONB NOT NULL,
  prospect_rank INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'generated'
);

-- One team's bid on one free agent in one round. UNIQUE lets a team revise
-- its own bid mid-round (upsert) without creating duplicates. Reused as-is
-- for the re-signing phase later (round numbers there just belong to that
-- phase's own 1-3 pass, no separate `phase` column needed since a season
-- only ever has one live round-number sequence active at a time).
CREATE TABLE IF NOT EXISTS free_agent_bids (
  id SERIAL PRIMARY KEY,
  season_number INTEGER NOT NULL,
  round INTEGER NOT NULL,
  player_id INTEGER NOT NULL REFERENCES players(id),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  aav_millions NUMERIC(5, 3) NOT NULL,
  years INTEGER NOT NULL,
  UNIQUE (season_number, round, player_id, team_id)
);

-- A human GM's offer to a CPU-controlled team during a trade_period round
-- (or the single post_playoff_trade round — `phase` distinguishes them
-- since both share this table). Two-sided like an instant Trade Center
-- offer (offered_* = what the proposer sends, requested_* = what they want
-- back from the CPU team), just not applied immediately — see store.js's
-- resolveTradeProposals for the round-end resolution. offered_value is
-- computed and frozen at submit time using the same discounted trade-value
-- math the instant Trade Center uses, so "most generous offer wins" among
-- conflicting proposals compares apples to apples. target_player_id is
-- legacy (superseded by target_team_id + requested_player_ids) and nullable
-- for that reason — kept only so old rows don't fail NOT NULL on restart.
CREATE TABLE IF NOT EXISTS trade_proposals (
  id SERIAL PRIMARY KEY,
  season_number INTEGER NOT NULL,
  round INTEGER NOT NULL,
  phase TEXT NOT NULL,
  proposing_team_id INTEGER NOT NULL REFERENCES teams(id),
  target_player_id INTEGER REFERENCES players(id),
  offered_player_ids INTEGER[] NOT NULL DEFAULT '{}',
  offered_pick_ids INTEGER[] NOT NULL DEFAULT '{}',
  offered_value NUMERIC NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
);

-- Idempotent on an existing table from before the two-sided redesign above —
-- relaxing NOT NULL and adding columns are both safe no-ops to re-run.
ALTER TABLE trade_proposals ALTER COLUMN target_player_id DROP NOT NULL;
ALTER TABLE trade_proposals ADD COLUMN IF NOT EXISTS target_team_id INTEGER REFERENCES teams(id);
ALTER TABLE trade_proposals ADD COLUMN IF NOT EXISTS requested_player_ids INTEGER[] NOT NULL DEFAULT '{}';
ALTER TABLE trade_proposals ADD COLUMN IF NOT EXISTS requested_pick_ids INTEGER[] NOT NULL DEFAULT '{}';

-- A CPU team's own trade offer TO a human team — the reverse direction of
-- trade_proposals above (there, a human proposes to a CPU; here, a CPU
-- proposes to a human). Kept as its own table rather than folded into
-- trade_proposals because the resolution semantics differ: a human's
-- proposal to a CPU auto-resolves by value/cap at round end, but a CPU's
-- offer to a human needs the human's own explicit accept/decline — nothing
-- should ever execute against a human's roster without them choosing it.
-- offered_* is what the CPU would send; requested_* is what the CPU wants
-- back from the human.
CREATE TABLE IF NOT EXISTS cpu_trade_offers (
  id SERIAL PRIMARY KEY,
  season_number INTEGER NOT NULL,
  round INTEGER NOT NULL,
  phase TEXT NOT NULL,
  cpu_team_id INTEGER NOT NULL REFERENCES teams(id),
  target_team_id INTEGER NOT NULL REFERENCES teams(id),
  offered_player_ids INTEGER[] NOT NULL DEFAULT '{}',
  offered_pick_ids INTEGER[] NOT NULL DEFAULT '{}',
  requested_player_ids INTEGER[] NOT NULL DEFAULT '{}',
  requested_pick_ids INTEGER[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
);

-- Marks a (season, round, phase) as "CPU offers already generated" even if
-- randomness meant zero offers actually got created that round — without
-- this, "no rows in cpu_trade_offers for this round" would be ambiguous
-- between "not generated yet" and "generated, nobody made an offer," and
-- every page load would regenerate a fresh (different) random batch.
CREATE TABLE IF NOT EXISTS cpu_trade_offer_batches (
  season_number INTEGER NOT NULL,
  round INTEGER NOT NULL,
  phase TEXT NOT NULL,
  PRIMARY KEY (season_number, round, phase)
);

-- A human GM's direct trade offer to another human-controlled team —
-- unlike a CPU trade, both sides are real people, so this never
-- auto-resolves; the target team must explicitly accept or decline (see
-- store.js's proposeTradeOffer/respondToHumanTradeOffer). No season/round/
-- phase scoping like the CPU tables above — the instant human-vs-human
-- trade flow this replaces was never phase-gated either, so this isn't.
CREATE TABLE IF NOT EXISTS human_trade_offers (
  id SERIAL PRIMARY KEY,
  proposing_team_id INTEGER NOT NULL REFERENCES teams(id),
  target_team_id INTEGER NOT NULL REFERENCES teams(id),
  offered_player_ids INTEGER[] NOT NULL DEFAULT '{}',
  offered_pick_ids INTEGER[] NOT NULL DEFAULT '{}',
  requested_player_ids INTEGER[] NOT NULL DEFAULT '{}',
  requested_pick_ids INTEGER[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per season's playoff outcome. A table rather than a single
-- mutable field so history isn't overwritten each season, and so it's
-- extensible once real bracket logic exists (NHL 27 details are still
-- unknown as of this schema — for now this only ever records a champion).
CREATE TABLE IF NOT EXISTS season_results (
  season_number INTEGER PRIMARY KEY,
  champion_team_id INTEGER REFERENCES teams(id)
);

-- A commissioner-set override for a single season's draft order, since real
-- playoffs happen on the NHL 27 console (not simulated here) and this app
-- only ever learns the champion — everyone else's elimination round is
-- otherwise unknown. Absent (no rows for a season) means the draft still
-- uses the live standings/roster-strength projection from computeDraftOrder;
-- once the commissioner saves an order here, it wins outright for that
-- season. Not archived/history-tracked like season_results — once a
-- season's draft is done, its order has no further use.
CREATE TABLE IF NOT EXISTS draft_order (
  season_number INTEGER NOT NULL,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (season_number, team_id),
  UNIQUE (season_number, position)
);

-- One row per team-facing event — "your bid won", "your trade proposal was
-- rejected", etc. Written only by the round-resolution functions
-- (resolveFreeAgencyRound / resolveResigningRound / resolveTradeProposals),
-- never by the submit-side actions, so this is always about outcomes, not
-- the act of submitting an offer. Read state lives here (not localStorage)
-- since there's no per-browser login — the "who am I" selector is just a
-- client convenience, so unread counts need to be tied to the team itself.
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read BOOLEAN NOT NULL DEFAULT false
);

-- 'success' | 'failure' — lets both the personal Notifications feed and the
-- league-wide Transactions page (which reuses this same table, see
-- getLeagueTransactions in store.js) style completed moves differently from
-- outbid/rejected/fell-through ones without parsing the message text.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS outcome TEXT NOT NULL DEFAULT 'success';

-- A login account for one of the human GMs. username (not email — this is a
-- private friend league, not a public signup product) is the unique handle;
-- team_id is which team this account is allowed to act as (nullable so a
-- commissioner-only account without a team is possible later). One user per
-- team for now — a join table would be premature until multi-team-per-user
-- is an actual requirement.
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  team_id INTEGER REFERENCES teams(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 'user' (default) or 'commissioner' — a commissioner can advance the
-- league's phase/date and touch other league-wide state (playoffs, draft
-- order/class); a normal user is scoped to acting as their own team. Plain
-- TEXT + app-level validation (see store.js's createUser), matching how
-- every other enum-shaped column in this schema (in_game_status, phase,
-- etc.) is already done — no DB-level CHECK constraint.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';

CREATE INDEX IF NOT EXISTS idx_notifications_team ON notifications(team_id, read);
CREATE INDEX IF NOT EXISTS idx_players_team_id ON players(team_id);
CREATE INDEX IF NOT EXISTS idx_free_agent_bids_round ON free_agent_bids(season_number, round);
CREATE INDEX IF NOT EXISTS idx_trade_proposals_round ON trade_proposals(season_number, round, phase);
CREATE INDEX IF NOT EXISTS idx_cpu_trade_offers_round ON cpu_trade_offers(season_number, round, phase, target_team_id);
CREATE INDEX IF NOT EXISTS idx_games_date ON games(date);
CREATE INDEX IF NOT EXISTS idx_draft_picks_season ON draft_picks(season_number);
CREATE INDEX IF NOT EXISTS idx_draft_picks_current_team ON draft_picks(current_team_id);
CREATE INDEX IF NOT EXISTS idx_draft_prospects_season ON draft_prospects(season_number);

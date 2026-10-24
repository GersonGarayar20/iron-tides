-- Phase 4 schema: accounts, ships and an auditable gold ledger. Applied
-- idempotently on every server startup (see migrate.ts) — no migration
-- framework for 3 tables.

CREATE TABLE IF NOT EXISTS players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  is_guest BOOLEAN NOT NULL DEFAULT true,
  email TEXT UNIQUE,
  password_hash TEXT,
  display_name TEXT NOT NULL,
  gold INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1,
  xp INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  class TEXT NOT NULL,
  -- Level per upgrade key, e.g. {"hull": 2, "sails": 1}. Missing keys mean
  -- level 0; covers all 6 implemented upgrades without further schema churn.
  upgrades JSONB NOT NULL DEFAULT '{}'::jsonb,
  hull REAL NOT NULL,
  ammo INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ships_player_id ON ships(player_id);

-- A player owns many ships but sails exactly one at a time; this enforces
-- that invariant at the database level, not just in application code.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ships_one_active_per_player
  ON ships(player_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS transactions (
  id BIGSERIAL PRIMARY KEY,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  -- Free text, not an enum: bot_kill, repair, upgrade_purchase,
  -- ship_purchase, ammo_resupply, loot_pickup, pvp, market_sale, ...
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transactions_player_id ON transactions(player_id);

-- Phase 5: missions, daily tasks, achievements, weekly stats/ranking, and
-- the login streak. Applied idempotently alongside the Phase 4 tables above
-- (ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS), same convention.

ALTER TABLE players ADD COLUMN IF NOT EXISTS streak_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS last_login_date DATE;
ALTER TABLE players ADD COLUMN IF NOT EXISTS lifetime_bots_sunk INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS lifetime_players_sunk INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS lifetime_gold_earned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS lifetime_missions_completed INTEGER NOT NULL DEFAULT 0;
-- Phase 7 (fourth slice): weekend-event boss kills; backs the boss_slayer
-- achievement, same pattern as every other lifetime_* counter above.
ALTER TABLE players ADD COLUMN IF NOT EXISTS lifetime_bosses_sunk INTEGER NOT NULL DEFAULT 0;
-- Text title unlocked by an achievement, shown next to the player's name;
-- no cosmetic/sprite system exists, so this plus a gold bonus is the
-- entire achievement reward.
ALTER TABLE players ADD COLUMN IF NOT EXISTS title TEXT;

CREATE TABLE IF NOT EXISTS missions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  mission_type TEXT NOT NULL,
  -- e.g. {"botKind":"pirate","count":5} / {"escortBotId":"bot-3","surviveSeconds":120}
  -- / {"x":900,"y":700,"radius":320}.
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  progress REAL NOT NULL DEFAULT 0,
  target REAL NOT NULL,
  reward_gold INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_missions_player_id ON missions(player_id);

-- Enforces "one active mission per type" at the DB level, matching the
-- dock's one-active-ship-per-player pattern.
CREATE UNIQUE INDEX IF NOT EXISTS idx_missions_one_active_per_type
  ON missions(player_id, mission_type) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS daily_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  task_date DATE NOT NULL,
  task_type TEXT NOT NULL,
  target INTEGER NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  reward_gold INTEGER NOT NULL,
  claimed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_daily_tasks_player_date ON daily_tasks(player_id, task_date);

-- Guards against generating duplicate same-type tasks on the same day
-- (ensureDailyTasks uses ON CONFLICT DO NOTHING against this).
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_tasks_unique_per_day
  ON daily_tasks(player_id, task_date, task_type);

-- Presence of a row = that day's single free reroll has been used; this
-- stays a separate tiny table rather than a column on daily_tasks because
-- the allowance is per-day, not per-task.
CREATE TABLE IF NOT EXISTS daily_reroll_used (
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  task_date DATE NOT NULL,
  used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, task_date)
);

-- Static achievement definitions live in shared/src/achievements.ts; this
-- table only records which ones a player has unlocked.
CREATE TABLE IF NOT EXISTS player_achievements (
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  achievement_key TEXT NOT NULL,
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, achievement_key)
);

-- Lazily created (insert-if-missing) on first event of a new week; used
-- for both weekly challenge progress and the ranking query. Monday-start
-- weeks, computed in UTC — see db/dateUtils.ts.
CREATE TABLE IF NOT EXISTS weekly_stats (
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  week_start_date DATE NOT NULL,
  gold_earned INTEGER NOT NULL DEFAULT 0,
  bots_sunk INTEGER NOT NULL DEFAULT 0,
  players_sunk INTEGER NOT NULL DEFAULT 0,
  -- e.g. {"weekly_bots_50": true} — marks a weekly challenge reward as
  -- already granted this week, so crossing the threshold again mid-week
  -- (or re-querying) can't double-pay it.
  claimed_goals JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (player_id, week_start_date)
);

CREATE INDEX IF NOT EXISTS idx_weekly_stats_week ON weekly_stats(week_start_date);

-- Phase 6 schema: chat reports, groups (in-memory only, nothing to persist),
-- clans (persisted alliances), and reputation/wanted-pirate columns on
-- players. Applied idempotently alongside every earlier phase's tables,
-- same convention.

ALTER TABLE players ADD COLUMN IF NOT EXISTS honor INTEGER NOT NULL DEFAULT 0;
-- NULL means "never flagged" / "flag expired"; isPirateFlagged in
-- shared/src/reputation.ts is the single source of truth for "is this
-- currently true", compared against now() here and against epoch-ms on the
-- mirrored ShipSchema field in the room.
ALTER TABLE players ADD COLUMN IF NOT EXISTS pirate_flag_until TIMESTAMPTZ;
ALTER TABLE players ADD COLUMN IF NOT EXISTS bounty INTEGER NOT NULL DEFAULT 0;

-- Chat is ephemeral/broadcast-only (no message log table) — the one piece
-- of chat that IS persisted is a reported message, for a human to review
-- later. There is no moderation UI yet; reporting only inserts this row.
CREATE TABLE IF NOT EXISTS chat_reports (
  id BIGSERIAL PRIMARY KEY,
  reporter_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  reported_player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  message_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  tag TEXT NOT NULL,
  flag_color_1 TEXT NOT NULL,
  -- Nullable: a clan can have one or two flag colors per the plan.
  flag_color_2 TEXT,
  bank_gold INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One clan per player, enforced at the DB level by making player_id the
-- primary key — same "one active X per player" pattern as
-- idx_ships_one_active_per_player / idx_missions_one_active_per_type.
CREATE TABLE IF NOT EXISTS clan_members (
  clan_id UUID NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
  player_id UUID PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  rank TEXT NOT NULL DEFAULT 'marinero',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clan_members_clan_id ON clan_members(clan_id);

-- Phase 7 (second slice): dynamic dock-to-dock commodity trade. Applied
-- idempotently alongside every earlier phase's tables, same convention.

-- Commodity -> quantity, e.g. {"ron": 12, "seda": 4}. Denormalized JSONB
-- like `ships.upgrades` rather than a separate table — small and simple
-- enough to stay that way.
ALTER TABLE ships ADD COLUMN IF NOT EXISTS cargo JSONB NOT NULL DEFAULT '{}'::jsonb;

-- One row per region (dock) per commodity. base_price is that dock's own
-- "fair value" for the good (discounted where it produces it, marked up
-- where it demands it — see shared/src/commodities.ts's basePriceFor);
-- current_price is the live, trade-moved price that drifts back toward it.
-- Seeded at server boot if missing — see db/commodities.ts's seedDockPrices.
CREATE TABLE IF NOT EXISTS dock_prices (
  region_id TEXT NOT NULL,
  commodity TEXT NOT NULL,
  current_price REAL NOT NULL,
  base_price REAL NOT NULL,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (region_id, commodity)
);

-- Phase 7 (fifth/final slice): player-to-player market + cosmetics.
-- Applied idempotently alongside every earlier phase's tables, same
-- convention.

-- One row per listed-for-sale cargo stack. Scoped per-dock (region_id, same
-- id space as dock_prices.region_id — see shared/src/world.ts) rather than
-- global: "un mercado en los muelles" implies a listing lives at the dock
-- it was posted at, same as the NPC dock-trade prices it sits next to in
-- the UI. status stays a row (never deleted) for the same auditability
-- reason transactions/player_achievements rows are never deleted either —
-- 'active' while buyable, 'sold' once fully bought out, 'cancelled' if the
-- seller pulled it back. quantity on a 'cancelled'/'sold' row is the exact
-- remaining amount at that moment, a historical snapshot, not live state.
CREATE TABLE IF NOT EXISTS market_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  region_id TEXT NOT NULL,
  commodity TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  price_per_unit INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_market_listings_region_status ON market_listings(region_id, status);
CREATE INDEX IF NOT EXISTS idx_market_listings_seller ON market_listings(seller_player_id);

-- Cosmetics: purely visual choices, one slot each, never read by
-- computeShipStats (shared/src/upgrades.ts). Defaulted to 'none' (the
-- pre-cosmetics look) — see shared/src/cosmetics.ts for the full catalog
-- and cost of every purchasable option per slot.
ALTER TABLE players ADD COLUMN IF NOT EXISTS cosmetic_hull_color TEXT NOT NULL DEFAULT 'none';
ALTER TABLE players ADD COLUMN IF NOT EXISTS cosmetic_sail_pattern TEXT NOT NULL DEFAULT 'none';
ALTER TABLE players ADD COLUMN IF NOT EXISTS cosmetic_flag_color TEXT NOT NULL DEFAULT 'none';
ALTER TABLE players ADD COLUMN IF NOT EXISTS cosmetic_wake_color TEXT NOT NULL DEFAULT 'none';

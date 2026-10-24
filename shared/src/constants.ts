export const MAX_SPEED = 220;
export const REVERSE_SPEED_FACTOR = 0.4;
export const ACCELERATION = 90;
export const DRAG = 70;
export const TURN_RATE = 1.6;
export const TURN_ACCELERATION = 3.5;

export const MAX_HULL = 100;
// The old flat per-ship hit-circle radius (used for combat hit detection,
// ship-vs-terrain collision, AND the world-boundary margin, identically
// for every ship class) was retired once the graphics overhaul gave each
// class its own visually distinct sprite size — see
// shared/src/shipClasses.ts's per-class `hitRadius` (combat/terrain) and
// `MAX_SHIP_HIT_RADIUS` (the generic world-boundary margin, sized to the
// largest ship so nothing can ever clip past an edge).

export const CANNON_RELOAD_SECONDS = 4;
export const CANNON_DAMAGE = 12;
export const CANNONS_PER_SIDE = 3;
export const CANNON_SPACING = 16;
export const CANNON_ORIGIN_OFFSET = 14;

export const CANNONBALL_SPEED = 420;
export const CANNONBALL_MAX_RANGE = 520;
// Range is enforced as a travel-time budget rather than tracking distance
// directly, since straight-line speed is constant.
export const CANNONBALL_LIFETIME_SECONDS = CANNONBALL_MAX_RANGE / CANNONBALL_SPEED;

export const BOT_DETECT_RANGE = 450;
export const BOT_ATTACK_RANGE = 280;
export const BOT_FLEE_HULL_RATIO = 0.3;
export const BOT_WAYPOINT_RADIUS = 80;
export const BOT_PATROL_RADIUS = 500;
// Deadzone avoids turn-input flicker once heading is close enough; tolerance
// is looser so attack doesn't stall waiting for a perfect broadside lock.
export const BOT_HEADING_DEADZONE = 0.05;
export const BOT_ATTACK_HEADING_TOLERANCE = 0.35;

export const BOT_TARGET_BASE_PIRATES = 4;
export const BOT_TARGET_BASE_MERCHANTS = 3;
export const BOT_TARGET_PER_PLAYER_PIRATES = 1;
export const BOT_TARGET_PER_PLAYER_MERCHANTS = 1;
export const BOT_TARGET_CAP_PER_KIND = 12;
export const BOT_RESPAWN_MIN_SECONDS = 30;
export const BOT_RESPAWN_MAX_SECONDS = 60;
export const BOT_SPAWN_MIN_PLAYER_DISTANCE = 700;

export const BOT_GOLD_REWARD_PIRATE = 8;
export const BOT_GOLD_REWARD_MERCHANT = 5;

// Phase 4 dock economy: gold-only costs (no material drops exist yet).
export const REPAIR_COST_PER_HULL = 2;
export const AMMO_COST_PER_UNIT = 1;

// Phase 5 login streak: every 7th consecutive UTC-day login grants a
// bonus-gold "chest" via the normal creditGold path (no item/inventory
// system exists, so a gold bonus is the honest equivalent of a chest).
export const LOGIN_STREAK_CHEST_INTERVAL = 7;
export const LOGIN_STREAK_CHEST_GOLD = 150;

// Phase 7 (first slice): region channels. 150 is a realistic "this region
// feels crowded" default per the plan's 100-200/region range; the server
// reads REGION_CHANNEL_CAP from the environment to override it (see
// server/src/env.ts) specifically so verification can set it very low (e.g.
// 3) and actually trigger a second channel without needing 150 real test
// connections. Legitimate testability affordance, not a gameplay knob.
export const DEFAULT_REGION_CHANNEL_CAP = 150;

// Phase 7 (fourth slice): weekend events and bosses. The boss is a bot
// (see BotKind) with much larger stats than any regular pirate/merchant —
// hull far above the Galeón's (220 base / 370 fully upgraded), and cannon
// damage above even a fully cannon-upgraded player (12 base + 3/level up
// to level 8 = 36 max). Never flees: see BOSS_FLEE_HULL_RATIO and
// server/src/ai/botAI.ts.
export const BOSS_MAX_HULL = 1200;
export const BOSS_CANNON_DAMAGE = 40;
export const BOSS_FLEE_HULL_RATIO = 0;

// Special attack: a heavier omnidirectional volley (not just a
// port/starboard broadside) fired every BOSS_VOLLEY_INTERVAL_SECONDS while
// the boss is in its "attack" AI state — see
// shared/src/physics.ts's getOmniVolleyDirections and
// server/src/rooms/OceanRoom.ts's fireBossVolley.
export const BOSS_VOLLEY_INTERVAL_SECONDS = 8;
export const BOSS_VOLLEY_BALL_COUNT = 10;
export const BOSS_VOLLEY_DAMAGE = 18;

// At most 1 boss per OceanRoom instance (the same per-room granularity
// every other bot already spawns at — see BOT_TARGET_CAP_PER_KIND), gated
// on the weekend event being active (shared/src/events.ts's isWeekendEvent,
// plus the FORCE_WEEKEND_EVENT test override — see
// server/src/weekendEvent.ts). After being sunk, a boss only respawns once
// this cooldown elapses AND the event is still active — it never respawns
// once the window ends.
export const BOSS_RESPAWN_COOLDOWN_SECONDS = 60;

// Large one-time gold payout for defeating a boss (split by damage
// contribution via the same creditGold path as a regular bot kill — see
// rewardBossKill) — the honest equivalent of the plan's "rare drop" for a
// game with no item/inventory system. Doubled like every other earned-gold
// credit while the weekend event is active (it can only ever be earned
// during the event, since that's the only time a boss exists).
export const BOSS_GOLD_REWARD = 1000;

// Weekend event: every gold-EARNING creditGold call is doubled while
// active — see db/dock.ts's creditGold and server/src/weekendEvent.ts.
export const WEEKEND_GOLD_MULTIPLIER = 2;

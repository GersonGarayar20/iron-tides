// Phase 6 reputation: honor + wanted pirates. All timestamps here are plain
// epoch-ms numbers, never Date objects — the server converts at the
// Postgres/Colyseus-schema boundary (see OceanRoom's onJoin/syncShipFromPlayer
// and db/reputation.ts), so these pure functions stay usable identically on
// client and server, same convention as isInSafeZone / computeShipStats.

// Deferred: the plan's novice-protection rule is "first 10 levels OR first 3
// hours." There's no working leveling/XP system yet (Phase 5 note), so only
// the account-age half is implemented; the level-based half is deferred
// until a real leveling system exists.
export const NOVICE_PROTECTION_HOURS = 3;

export function isNoviceProtected(createdAtMs: number, nowMs: number = Date.now()): boolean {
  return nowMs - createdAtMs < NOVICE_PROTECTION_HOURS * 60 * 60 * 1000;
}

// A flagged pirate's timer is never refreshed by a further unprovoked
// attack — only set while unflagged (see OceanRoom.maybeFlagPirate) — so
// this window is a hard ceiling from the moment of the first offense.
export const PIRATE_FLAG_DURATION_SECONDS = 600;

export function isPirateFlagged(pirateFlagUntilMs: number, nowMs: number = Date.now()): boolean {
  return pirateFlagUntilMs > nowMs;
}

// Asymmetric by design: sinking a flagged pirate (or a pirate-kind bot) is a
// small reward; sinking an innocent (unflagged) player is a much bigger
// penalty, discouraging griefing far more than it rewards bounty-hunting.
export const HONOR_GAIN_PIRATE_KILL = 5;
export const HONOR_LOSS_INNOCENT_KILL = 20;

// Gold added to a flagged pirate's bounty each time they sink another
// player while flagged. Paid out (and reset to 0) to whoever sinks them —
// see db/reputation.ts's payoutBounty. The flag itself is left alone and
// expires on its own timer rather than clearing immediately on death.
export const BOUNTY_GAIN_PER_KILL = 50;

// Honor-gated dock pricing: with only one dock in the world, reputation is
// expressed as a price modifier there instead of multiple docks with
// different policies. Below the floor, the dock refuses service outright.
export const HONOR_SERVICE_FLOOR = -50;
export const HONOR_PENALTY_THRESHOLD = -20;
export const HONOR_PENALTY_MULTIPLIER = 1.5;
export const HONOR_DISCOUNT_THRESHOLD = 50;
export const HONOR_DISCOUNT_MULTIPLIER = 0.9;

export function isDockServiceRefused(honor: number): boolean {
  return honor < HONOR_SERVICE_FLOOR;
}

export function honorPriceMultiplier(honor: number): number {
  if (honor >= HONOR_DISCOUNT_THRESHOLD) return HONOR_DISCOUNT_MULTIPLIER;
  if (honor <= HONOR_PENALTY_THRESHOLD) return HONOR_PENALTY_MULTIPLIER;
  return 1;
}

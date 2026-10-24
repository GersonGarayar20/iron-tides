import type { Pool, PoolClient } from "pg";
import {
  AMMO_COST_PER_UNIT,
  computeShipStats,
  costForUpgradeLevel,
  honorPriceMultiplier,
  isDockServiceRefused,
  REPAIR_COST_PER_HULL,
  SHIP_CLASSES,
  UPGRADE_CAPS_BY_CLASS,
  UPGRADE_DEFS,
  WEEKEND_GOLD_MULTIPLIER,
  ZERO_UPGRADES,
  type ShipClassKey,
  type UpgradeKey,
  type UpgradeLevels,
} from "@iron-tides/shared";
import { pool } from "./pool";
import type { ShipRow } from "./ships";
import { isWeekendEventActive } from "../weekendEvent";

// Phase 7 (fourth slice): weekend double-gold. creditGold is the one
// choke point every actually-EARNED gold credit already flows through
// (bot/boss kills, loot pickups, bounty payouts, commodity-sell profit,
// daily task/mission/weekly-challenge/achievement rewards, login-streak
// chests) — debitGold (every dock purchase/repair/upgrade/ship-purchase)
// is a completely separate function and is never touched by this.
// clan_bank_withdraw is the one creditGold call that is NOT earned gold —
// it's a clan member pulling their own previously-donated gold back out of
// the clan bank — so it's excluded here; doubling it would let a clan
// mint free gold via a donate-then-withdraw round-trip during the event.
const GOLD_DOUBLING_EXCLUDED_TYPES = new Set<string>(["clan_bank_withdraw"]);

export interface DockActionResult {
  ok: boolean;
  reason?: string;
  gold?: number;
  ship?: ShipRow;
}

const DOCK_REFUSAL_REASON = "the dock refuses service: your reputation is too low";

// Exported for db/clans.ts's bank donate/withdraw, which needs the exact
// same atomic-transaction discipline as every purchase below.
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Atomic conditional debit: the UPDATE's WHERE clause checks the balance
// itself, so an unaffordable purchase touches zero rows (no gold lost, no
// orphan transaction row) instead of racing a separate SELECT-then-UPDATE.
// Never call with a client outside an open transaction when paired with
// further writes — callers below always run this inside withTransaction.
// Exported for db/clans.ts's bank donation (debit the donor atomically
// alongside the clan-bank credit).
export async function debitGold(
  client: PoolClient,
  playerId: string,
  amount: number,
  type: string
): Promise<number | null> {
  const { rows } = await client.query<{ balance_after: number }>(
    `WITH updated AS (
       UPDATE players SET gold = gold - $1 WHERE id = $2 AND gold >= $1 RETURNING gold
     )
     INSERT INTO transactions (player_id, type, amount, balance_after)
     SELECT $2, $3, -$1, gold FROM updated
     RETURNING balance_after`,
    [amount, playerId, type]
  );
  return rows[0]?.balance_after ?? null;
}

// Single-statement atomic credit. Safe to call directly on the pool (the
// default `client`) when there's no second write to pair it with — bot-kill
// rewards, loot pickups, bounty payouts — or inside an existing transaction
// (db/clans.ts's bank withdrawal) by passing that transaction's client.
export async function creditGold(
  playerId: string,
  amount: number,
  type: string,
  client: Pool | PoolClient = pool
): Promise<number> {
  const creditedAmount =
    isWeekendEventActive() && amount > 0 && !GOLD_DOUBLING_EXCLUDED_TYPES.has(type)
      ? amount * WEEKEND_GOLD_MULTIPLIER
      : amount;

  const { rows } = await client.query<{ balance_after: number }>(
    `WITH updated AS (
       UPDATE players SET gold = gold + $1 WHERE id = $2 RETURNING gold
     )
     INSERT INTO transactions (player_id, type, amount, balance_after)
     SELECT $2, $3, $1, gold FROM updated
     RETURNING balance_after`,
    [creditedAmount, playerId, type]
  );
  return rows[0].balance_after;
}

// `honor` is the caller's current reputation (OceanRoom already mirrors it
// on the ship schema, so no extra query is needed here) — see
// shared/src/reputation.ts for the floor/multiplier this applies.
export async function buyShip(
  playerId: string,
  classKey: ShipClassKey,
  honor: number
): Promise<DockActionResult> {
  const classDef = SHIP_CLASSES[classKey];
  if (!classDef || classKey === "bot-default") return { ok: false, reason: "unknown ship class" };
  if (isDockServiceRefused(honor)) return { ok: false, reason: DOCK_REFUSAL_REASON };

  const price = Math.max(1, Math.round(classDef.price * honorPriceMultiplier(honor)));

  return withTransaction(async (client) => {
    const balance = await debitGold(client, playerId, price, "ship_purchase");
    if (balance === null) return { ok: false, reason: "insufficient gold" };

    const stats = computeShipStats(classKey, ZERO_UPGRADES);
    const { rows } = await client.query<ShipRow>(
      `INSERT INTO ships (player_id, class, upgrades, hull, ammo, is_active)
       VALUES ($1, $2, $3::jsonb, $4, $5, false) RETURNING *`,
      [playerId, classKey, JSON.stringify(ZERO_UPGRADES), stats.maxHull, stats.maxAmmo]
    );
    return { ok: true, gold: balance, ship: rows[0] };
  });
}

// Switching is free (gold already spent at purchase time); the previous
// ship stays owned and switchable, per the plan.
export async function switchActiveShip(playerId: string, shipId: string): Promise<DockActionResult> {
  return withTransaction(async (client) => {
    const { rows: owned } = await client.query<ShipRow>(
      `SELECT * FROM ships WHERE id = $1 AND player_id = $2`,
      [shipId, playerId]
    );
    const target = owned[0];
    if (!target) return { ok: false, reason: "ship not owned" };
    if (target.is_active) return { ok: true, ship: target };

    // Clear the old active flag before setting the new one so the partial
    // unique index (one active ship per player) is never violated mid-swap.
    await client.query(`UPDATE ships SET is_active = false WHERE player_id = $1 AND is_active = true`, [
      playerId,
    ]);
    await client.query(`UPDATE ships SET is_active = true WHERE id = $1`, [shipId]);
    return { ok: true, ship: { ...target, is_active: true } };
  });
}

export async function repairShip(
  playerId: string,
  ship: ShipRow,
  honor: number
): Promise<DockActionResult> {
  if (isDockServiceRefused(honor)) return { ok: false, reason: DOCK_REFUSAL_REASON };

  const stats = computeShipStats(ship.class, ship.upgrades);
  const missing = stats.maxHull - ship.hull;
  if (missing <= 0) return { ok: false, reason: "hull already full" };

  const cost = Math.max(1, Math.ceil(missing * REPAIR_COST_PER_HULL * honorPriceMultiplier(honor)));

  return withTransaction(async (client) => {
    const balance = await debitGold(client, playerId, cost, "repair");
    if (balance === null) return { ok: false, reason: "insufficient gold" };

    await client.query(`UPDATE ships SET hull = $1 WHERE id = $2`, [stats.maxHull, ship.id]);
    return { ok: true, gold: balance, ship: { ...ship, hull: stats.maxHull } };
  });
}

export async function buyAmmo(
  playerId: string,
  ship: ShipRow,
  honor: number
): Promise<DockActionResult> {
  if (isDockServiceRefused(honor)) return { ok: false, reason: DOCK_REFUSAL_REASON };

  const stats = computeShipStats(ship.class, ship.upgrades);
  const missing = stats.maxAmmo - ship.ammo;
  if (missing <= 0) return { ok: false, reason: "ammo already full" };

  const cost = Math.max(1, Math.ceil(missing * AMMO_COST_PER_UNIT * honorPriceMultiplier(honor)));

  return withTransaction(async (client) => {
    const balance = await debitGold(client, playerId, cost, "ammo_resupply");
    if (balance === null) return { ok: false, reason: "insufficient gold" };

    await client.query(`UPDATE ships SET ammo = $1 WHERE id = $2`, [stats.maxAmmo, ship.id]);
    return { ok: true, gold: balance, ship: { ...ship, ammo: stats.maxAmmo } };
  });
}

export async function buyUpgrade(
  playerId: string,
  ship: ShipRow,
  key: UpgradeKey,
  honor: number
): Promise<DockActionResult> {
  if (isDockServiceRefused(honor)) return { ok: false, reason: DOCK_REFUSAL_REASON };

  const cap = UPGRADE_CAPS_BY_CLASS[ship.class]?.[key] ?? 0;
  const currentLevel = ship.upgrades[key] ?? 0;
  if (currentLevel >= cap) return { ok: false, reason: "upgrade at this ship class's max level" };

  const nextLevel = currentLevel + 1;
  const cost = Math.max(
    1,
    Math.round(costForUpgradeLevel(UPGRADE_DEFS[key], nextLevel) * honorPriceMultiplier(honor))
  );

  return withTransaction(async (client) => {
    const balance = await debitGold(client, playerId, cost, "upgrade_purchase");
    if (balance === null) return { ok: false, reason: "insufficient gold" };

    const nextUpgrades: UpgradeLevels = { ...ship.upgrades, [key]: nextLevel };
    const prevStats = computeShipStats(ship.class, ship.upgrades);
    const nextStats = computeShipStats(ship.class, nextUpgrades);
    // Carry forward the same absolute damage taken rather than the same
    // ratio, so a hull upgrade heals exactly the hull points it just added.
    const nextHull = Math.min(nextStats.maxHull, ship.hull + (nextStats.maxHull - prevStats.maxHull));

    await client.query(`UPDATE ships SET upgrades = $1::jsonb, hull = $2 WHERE id = $3`, [
      JSON.stringify(nextUpgrades),
      nextHull,
      ship.id,
    ]);

    return { ok: true, gold: balance, ship: { ...ship, upgrades: nextUpgrades, hull: nextHull } };
  });
}

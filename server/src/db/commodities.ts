import type { Pool, PoolClient } from "pg";
import {
  applyTradeShift,
  basePriceFor,
  COMMODITY_KEYS,
  computeShipStats,
  isDockServiceRefused,
  recoverPrice,
  totalCargoQuantity,
  type CargoHold,
  type CommodityKey,
} from "@iron-tides/shared";
import { pool } from "./pool";
import { creditGold, debitGold, withTransaction } from "./dock";
import type { ShipRow } from "./ships";

const DOCK_REFUSAL_REASON = "the dock refuses service: your reputation is too low";

export interface DockPriceInfo {
  commodity: CommodityKey;
  currentPrice: number;
  basePrice: number;
}

export interface CommodityTradeResult {
  ok: boolean;
  reason?: string;
  gold?: number;
  cargo?: CargoHold;
  newPrice?: number;
}

// Idempotent per-region-per-commodity seed, run once at server boot (see
// server/src/index.ts) — ON CONFLICT DO NOTHING against the table's own
// (region_id, commodity) primary key, same "just re-apply, let the DB
// enforce idempotency" spirit as schema.sql itself.
export async function seedDockPrices(regionIds: string[]): Promise<void> {
  for (const regionId of regionIds) {
    for (const commodity of COMMODITY_KEYS) {
      const base = basePriceFor(regionId, commodity);
      await pool.query(
        `INSERT INTO dock_prices (region_id, commodity, current_price, base_price)
         VALUES ($1, $2, $3, $3)
         ON CONFLICT (region_id, commodity) DO NOTHING`,
        [regionId, commodity, base]
      );
    }
  }
}

async function readRecoveredPrice(
  client: Pool | PoolClient,
  regionId: string,
  commodity: CommodityKey,
  forUpdate: boolean
): Promise<{ current: number; base: number } | null> {
  const { rows } = await client.query<{ current_price: number; base_price: number; last_updated: Date }>(
    `SELECT current_price, base_price, last_updated FROM dock_prices
     WHERE region_id = $1 AND commodity = $2 ${forUpdate ? "FOR UPDATE" : ""}`,
    [regionId, commodity]
  );
  const row = rows[0];
  if (!row) return null;

  const elapsedMs = Date.now() - row.last_updated.getTime();
  const current = recoverPrice(row.current_price, row.base_price, elapsedMs);
  return { current, base: row.base_price };
}

// Plain read for the Mercado tab — no row lock, no write. The recovered
// value is only ever persisted by the next actual trade (see
// buyCommodity/sellCommodity below); re-reading it here costs nothing and
// is always correct regardless of how long it's been since the last trade.
export async function listDockPrices(regionId: string): Promise<DockPriceInfo[]> {
  const prices: DockPriceInfo[] = [];
  for (const commodity of COMMODITY_KEYS) {
    const info = await readRecoveredPrice(pool, regionId, commodity, false);
    if (info) prices.push({ commodity, currentPrice: Math.round(info.current), basePrice: Math.round(info.base) });
  }
  return prices;
}

// Exported for db/market.ts, which needs the exact same "clamp at zero,
// shallow-copy the rest" cargo-mutation discipline for listing escrow/
// cancel/buy — reused rather than reimplemented, same as creditGold/
// debitGold/withTransaction from db/dock.ts.
export function cargoWithDelta(cargo: CargoHold, commodity: CommodityKey, delta: number): CargoHold {
  const next = { ...cargo };
  next[commodity] = Math.max(0, (next[commodity] ?? 0) + delta);
  return next;
}

export async function buyCommodity(
  playerId: string,
  ship: ShipRow,
  regionId: string,
  commodity: CommodityKey,
  quantity: number,
  honor: number
): Promise<CommodityTradeResult> {
  if (isDockServiceRefused(honor)) return { ok: false, reason: DOCK_REFUSAL_REASON };
  if (!Number.isFinite(quantity) || quantity <= 0) return { ok: false, reason: "invalid quantity" };

  const capacity = computeShipStats(ship.class, ship.upgrades).cargoCapacity;
  const used = totalCargoQuantity(ship.cargo);
  if (quantity > capacity - used) return { ok: false, reason: "not enough cargo hold space" };

  return withTransaction(async (client) => {
    const priceInfo = await readRecoveredPrice(client, regionId, commodity, true);
    if (!priceInfo) return { ok: false, reason: "unknown dock" };

    const unitPrice = Math.max(1, Math.round(priceInfo.current));
    const cost = unitPrice * quantity;

    const balance = await debitGold(client, playerId, cost, "commodity_buy");
    if (balance === null) return { ok: false, reason: "insufficient gold" };

    const newPrice = applyTradeShift(priceInfo.current, priceInfo.base, quantity, "buy");
    await client.query(
      `UPDATE dock_prices SET current_price = $1, last_updated = now() WHERE region_id = $2 AND commodity = $3`,
      [newPrice, regionId, commodity]
    );

    const nextCargo = cargoWithDelta(ship.cargo, commodity, quantity);
    await client.query(`UPDATE ships SET cargo = $1::jsonb WHERE id = $2`, [JSON.stringify(nextCargo), ship.id]);

    return { ok: true, gold: balance, cargo: nextCargo, newPrice: Math.round(newPrice) };
  });
}

export async function sellCommodity(
  playerId: string,
  ship: ShipRow,
  regionId: string,
  commodity: CommodityKey,
  quantity: number,
  honor: number
): Promise<CommodityTradeResult> {
  if (isDockServiceRefused(honor)) return { ok: false, reason: DOCK_REFUSAL_REASON };
  if (!Number.isFinite(quantity) || quantity <= 0) return { ok: false, reason: "invalid quantity" };

  const owned = ship.cargo[commodity] ?? 0;
  if (quantity > owned) return { ok: false, reason: "not enough cargo to sell" };

  return withTransaction(async (client) => {
    const priceInfo = await readRecoveredPrice(client, regionId, commodity, true);
    if (!priceInfo) return { ok: false, reason: "unknown dock" };

    const unitPrice = Math.max(1, Math.round(priceInfo.current));
    const revenue = unitPrice * quantity;

    const balance = await creditGold(playerId, revenue, "commodity_sell", client);

    const newPrice = applyTradeShift(priceInfo.current, priceInfo.base, quantity, "sell");
    await client.query(
      `UPDATE dock_prices SET current_price = $1, last_updated = now() WHERE region_id = $2 AND commodity = $3`,
      [newPrice, regionId, commodity]
    );

    const nextCargo = cargoWithDelta(ship.cargo, commodity, -quantity);
    await client.query(`UPDATE ships SET cargo = $1::jsonb WHERE id = $2`, [JSON.stringify(nextCargo), ship.id]);

    return { ok: true, gold: balance, cargo: nextCargo, newPrice: Math.round(newPrice) };
  });
}

// Scavenged cargo picked up from a wreck's floating loot (see
// OceanRoom.awardCargoLoot) — no gold or dock-price change, just an
// inventory grant, so it deliberately doesn't go through buyCommodity's
// pricing machinery at all. `currentCargo` is the caller's own
// already-authoritative mirror (every cargo change writes straight
// through to Postgres, same discipline as gold — see db/dock.ts), so this
// needs no extra SELECT first.
export async function grantShipCargo(
  shipId: string,
  commodity: CommodityKey,
  quantity: number,
  currentCargo: CargoHold
): Promise<CargoHold> {
  const nextCargo = cargoWithDelta(currentCargo, commodity, quantity);
  await pool.query(`UPDATE ships SET cargo = $1::jsonb WHERE id = $2`, [JSON.stringify(nextCargo), shipId]);
  return nextCargo;
}

// Phase 7 (second slice) economy control: a sunk ship loses its cargo
// entirely (see OceanRoom.handleCargoLossOnSink). Some of it may become
// scavengable floating loot, but either way the ship's hold itself is
// emptied here.
export async function clearShipCargo(shipId: string): Promise<void> {
  await pool.query(`UPDATE ships SET cargo = '{}'::jsonb WHERE id = $1`, [shipId]);
}

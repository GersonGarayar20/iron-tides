// Phase 7 (second slice): dynamic dock-to-dock commodity trade. Pure
// functions only — the single source of truth for pricing math, used
// identically by server/src/db/commodities.ts (authoritative) and the
// client's Mercado tab (display only, never trusted for the actual charge).

export type CommodityKey = "ron" | "especias" | "seda" | "madera";

export interface CommodityDef {
  key: CommodityKey;
  name: string;
  // Reference price before any per-dock production/demand skew (see
  // basePriceFor below) — not itself persisted anywhere.
  basePrice: number;
}

export const COMMODITIES: Record<CommodityKey, CommodityDef> = {
  ron: { key: "ron", name: "Ron", basePrice: 40 },
  especias: { key: "especias", name: "Especias", basePrice: 90 },
  seda: { key: "seda", name: "Seda", basePrice: 70 },
  madera: { key: "madera", name: "Madera", basePrice: 30 },
};

export const COMMODITY_KEYS: CommodityKey[] = ["ron", "especias", "seda", "madera"];

// A ship's cargo hold: commodity -> quantity. Missing key means 0, same
// sparse convention as UpgradeLevels in shared/src/upgrades.ts.
export type CargoHold = Partial<Record<CommodityKey, number>>;

export function totalCargoQuantity(cargo: CargoHold): number {
  return COMMODITY_KEYS.reduce((sum, key) => sum + (cargo[key] ?? 0), 0);
}

export interface DockTradeProfile {
  produces: CommodityKey; // sold cheap at this dock
  demands: CommodityKey; // bought at a premium at this dock
}

// One produce/demand pair per region (keyed by the exact RegionDef.id from
// shared/src/world.ts), chained around the 2x2 grid so every dock both
// sells something cheap and buys something at a premium, and the chain as
// a whole forms a real round trip: (0,0) ron -> sell at (0,1); (0,1)
// especias -> sell at (1,1); (1,1) madera -> sell at (1,0); (1,0) seda ->
// sell at (0,0). No dock produces or demands more than one good, so there's
// always a genuine reason to sail cargo between two specific docks rather
// than just picking whichever is closest.
export const DOCK_TRADE_PROFILES: Record<string, DockTradeProfile> = {
  "0,0": { produces: "ron", demands: "seda" },
  "1,0": { produces: "seda", demands: "madera" },
  "1,1": { produces: "madera", demands: "especias" },
  "0,1": { produces: "especias", demands: "ron" },
};

const PRODUCE_PRICE_FACTOR = 0.6;
const DEMAND_PRICE_FACTOR = 1.6;

// A dock's own "fair value" for a commodity — persisted as dock_prices'
// base_price column, and what current_price drifts back toward. Discounted
// where the dock produces it, marked up where the dock demands it, left at
// the plain reference price everywhere else.
export function basePriceFor(regionId: string, commodity: CommodityKey): number {
  const profile = DOCK_TRADE_PROFILES[regionId];
  const reference = COMMODITIES[commodity].basePrice;
  if (profile?.produces === commodity) return Math.round(reference * PRODUCE_PRICE_FACTOR);
  if (profile?.demands === commodity) return Math.round(reference * DEMAND_PRICE_FACTOR);
  return reference;
}

// Bounds are relative to each dock's own base_price (not the global
// reference price), so a demand dock's premium ceiling stays proportionate
// to its already-marked-up baseline instead of an unrelated global number.
const MIN_PRICE_FACTOR = 0.4;
const MAX_PRICE_FACTOR = 2.5;

function clampPrice(price: number, basePrice: number): number {
  return Math.max(basePrice * MIN_PRICE_FACTOR, Math.min(basePrice * MAX_PRICE_FACTOR, price));
}

// Percentage of base_price the price shifts per unit traded in one order.
// Buying nudges the price up (that dock's stock is getting scarcer);
// selling nudges it down (the local market is getting flooded). A flat
// per-unit percentage, not integrated marginal pricing within one order —
// simple and tunable per the plan, not real economic modeling, but still
// visibly responsive after every trade.
const PRICE_SHIFT_PER_UNIT = 0.015;

export function applyTradeShift(
  currentPrice: number,
  basePrice: number,
  quantity: number,
  direction: "buy" | "sell"
): number {
  const delta = basePrice * PRICE_SHIFT_PER_UNIT * quantity * (direction === "buy" ? 1 : -1);
  return clampPrice(currentPrice + delta, basePrice);
}

// Recovery toward base_price is computed lazily from elapsed wall-clock
// time since the stored last_updated, rather than a live server-side
// interval loop: every price read/trade recomputes it fresh from
// (current_price, base_price, now - last_updated), which is both exactly
// reproducible in tests by rewinding last_updated directly in Postgres
// (the same technique prior phases used for date-based features) and
// correct no matter which of a region's several channel rooms last
// touched that dock's price. Compounding geometric decay: each full
// RECOVERY_INTERVAL_SECONDS that elapses closes RECOVERY_FRACTION_PER_INTERVAL
// of whatever gap remains to base_price.
const RECOVERY_INTERVAL_SECONDS = 30;
const RECOVERY_FRACTION_PER_INTERVAL = 0.08;

export function recoverPrice(currentPrice: number, basePrice: number, elapsedMs: number): number {
  const elapsedSeconds = elapsedMs / 1000;
  const intervals = Math.floor(elapsedSeconds / RECOVERY_INTERVAL_SECONDS);
  if (intervals <= 0) return currentPrice;

  const retained = (1 - RECOVERY_FRACTION_PER_INTERVAL) ** intervals;
  return basePrice + (currentPrice - basePrice) * retained;
}

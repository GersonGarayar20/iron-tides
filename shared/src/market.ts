// Phase 7 (fifth/final slice): player-to-player market. A dock-scoped
// listings board layered on top of the Phase 7.2 NPC commodity trade — a
// genuinely separate system (see server/src/db/market.ts) that only shares
// the CommodityKey/CargoHold vocabulary from commodities.ts. Pure
// commission math only, the single source of truth for both the
// authoritative server math (db/market.ts) and the client's price preview.
export const MARKET_COMMISSION_RATE = 0.05;

// Rounded the same way every other gold-affecting computation in this
// codebase rounds (see shared/src/upgrades.ts/commodities.ts) — nearest
// gold, never fractional.
export function marketCommission(totalSale: number): number {
  return Math.round(totalSale * MARKET_COMMISSION_RATE);
}

// totalSale - marketCommission(totalSale), computed this way (rather than
// totalSale * (1 - rate)) so the two numbers always add back up exactly to
// totalSale — the commission is a pure gold sink, never credited to
// anyone, so the ledger must net out to the cent (see db/market.ts's
// buyListing, which credits exactly this to the seller and nothing else to
// anyone for the remaining 5%).
export function marketSellerNet(totalSale: number): number {
  return totalSale - marketCommission(totalSale);
}

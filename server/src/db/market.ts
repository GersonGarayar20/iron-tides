import {
  computeShipStats,
  marketSellerNet,
  totalCargoQuantity,
  type CargoHold,
  type CommodityKey,
} from "@iron-tides/shared";
import { pool } from "./pool";
import { creditGold, debitGold, withTransaction } from "./dock";
import { cargoWithDelta } from "./commodities";
import type { ShipRow } from "./ships";

// Phase 7 (fifth/final slice): the player-to-player market. A genuinely
// separate system from db/commodities.ts's NPC dock trade — this never
// touches dock_prices, and the NPC trade never touches market_listings.
// Both share the exact same atomic-transaction/audit-row discipline from
// db/dock.ts (withTransaction, creditGold, debitGold).

export interface MarketListingInfo {
  id: string;
  sellerPlayerId: string;
  sellerDisplayName: string;
  commodity: CommodityKey;
  quantity: number;
  pricePerUnit: number;
  createdAt: string;
}

export interface MarketActionResult {
  ok: boolean;
  reason?: string;
  cargo?: CargoHold;
  gold?: number;
  listingId?: string;
}

// Per-dock (region_id), not global — a listing is only ever visible/buyable
// from the exact dock it was posted at, matching the plan's "en los
// muelles" wording and the same region_id scoping dock_prices already
// uses. The cross-room directory from Phase 7.1 is deliberately not
// reused here: listings are DB rows, not live room state, so every
// channel-room of a region already sees the same rows for free via this
// one query — no cross-room plumbing needed for same-region visibility,
// and global visibility was never the goal.
export async function listActiveListings(regionId: string): Promise<MarketListingInfo[]> {
  const { rows } = await pool.query<{
    id: string;
    seller_player_id: string;
    display_name: string;
    commodity: CommodityKey;
    quantity: number;
    price_per_unit: number;
    created_at: Date;
  }>(
    `SELECT l.id, l.seller_player_id, p.display_name, l.commodity, l.quantity, l.price_per_unit, l.created_at
     FROM market_listings l JOIN players p ON p.id = l.seller_player_id
     WHERE l.region_id = $1 AND l.status = 'active'
     ORDER BY l.created_at ASC`,
    [regionId]
  );
  return rows.map((r) => ({
    id: r.id,
    sellerPlayerId: r.seller_player_id,
    sellerDisplayName: r.display_name,
    commodity: r.commodity,
    quantity: r.quantity,
    pricePerUnit: r.price_per_unit,
    createdAt: r.created_at.toISOString(),
  }));
}

// Listing immediately escrows the cargo out of the seller's hold (within
// the same transaction as the INSERT) — it's reserved, not sellable/usable
// by the seller again until bought or cancelled.
export async function createListing(
  playerId: string,
  ship: ShipRow,
  regionId: string,
  commodity: CommodityKey,
  quantity: number,
  pricePerUnit: number
): Promise<MarketActionResult> {
  if (!Number.isFinite(quantity) || quantity <= 0) return { ok: false, reason: "invalid quantity" };
  if (!Number.isFinite(pricePerUnit) || pricePerUnit <= 0) return { ok: false, reason: "invalid price" };

  const qty = Math.floor(quantity);
  const price = Math.floor(pricePerUnit);
  const owned = ship.cargo[commodity] ?? 0;
  if (qty > owned) return { ok: false, reason: "not enough cargo to list" };

  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO market_listings (seller_player_id, region_id, commodity, quantity, price_per_unit)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [playerId, regionId, commodity, qty, price]
    );

    const nextCargo = cargoWithDelta(ship.cargo, commodity, -qty);
    await client.query(`UPDATE ships SET cargo = $1::jsonb WHERE id = $2`, [JSON.stringify(nextCargo), ship.id]);

    return { ok: true, cargo: nextCargo, listingId: rows[0].id };
  });
}

// Seller-only; only succeeds if the seller currently has enough free hold
// space to take the escrowed cargo back — consistent with the exact same
// capacity enforcement buyCommodity uses, rather than silently letting a
// cancel push them over capacity.
export async function cancelListing(playerId: string, ship: ShipRow, listingId: string): Promise<MarketActionResult> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{
      id: string;
      seller_player_id: string;
      commodity: CommodityKey;
      quantity: number;
      status: string;
    }>(`SELECT id, seller_player_id, commodity, quantity, status FROM market_listings WHERE id = $1 FOR UPDATE`, [
      listingId,
    ]);
    const listing = rows[0];
    if (!listing) return { ok: false, reason: "listing not found" };
    if (listing.seller_player_id !== playerId) return { ok: false, reason: "not your listing" };
    if (listing.status !== "active") return { ok: false, reason: "listing no longer active" };

    const capacity = computeShipStats(ship.class, ship.upgrades).cargoCapacity;
    const used = totalCargoQuantity(ship.cargo);
    if (listing.quantity > capacity - used) {
      return { ok: false, reason: "not enough cargo hold space to reclaim this listing" };
    }

    await client.query(`UPDATE market_listings SET status = 'cancelled' WHERE id = $1`, [listingId]);

    const nextCargo = cargoWithDelta(ship.cargo, listing.commodity, listing.quantity);
    await client.query(`UPDATE ships SET cargo = $1::jsonb WHERE id = $2`, [JSON.stringify(nextCargo), ship.id]);

    return { ok: true, cargo: nextCargo };
  });
}

// Any other player may buy up to the full listed quantity; a partial buy
// just reduces the listing's quantity instead of requiring the whole
// stack. `FOR UPDATE` on the listing row is the one real concurrency risk
// in this whole feature — unlike a player's own gold/cargo (owned by at
// most one connected room at a time, per this codebase's concurrency
// model — see db/dock.ts's comments), a listing is a shared resource two
// different buyers' rooms could hit at the same instant.
export async function buyListing(
  buyerId: string,
  buyerShip: ShipRow,
  regionId: string,
  listingId: string,
  quantity: number
): Promise<MarketActionResult> {
  if (!Number.isFinite(quantity) || quantity <= 0) return { ok: false, reason: "invalid quantity" };
  const qty = Math.floor(quantity);

  return withTransaction(async (client) => {
    const { rows } = await client.query<{
      id: string;
      seller_player_id: string;
      region_id: string;
      commodity: CommodityKey;
      quantity: number;
      price_per_unit: number;
      status: string;
    }>(`SELECT * FROM market_listings WHERE id = $1 FOR UPDATE`, [listingId]);
    const listing = rows[0];
    if (!listing || listing.status !== "active") return { ok: false, reason: "listing not found" };
    // Enforced server-side, not just by the client only ever showing
    // same-region listings — a listing posted at one dock must never be
    // buyable from a different dock even via a crafted message.
    if (listing.region_id !== regionId) return { ok: false, reason: "listing is at a different dock" };
    if (listing.seller_player_id === buyerId) return { ok: false, reason: "cannot buy your own listing" };
    if (qty > listing.quantity) return { ok: false, reason: "not enough quantity left in this listing" };

    const capacity = computeShipStats(buyerShip.class, buyerShip.upgrades).cargoCapacity;
    const used = totalCargoQuantity(buyerShip.cargo);
    if (qty > capacity - used) return { ok: false, reason: "not enough cargo hold space" };

    const totalSale = listing.price_per_unit * qty;
    // marketCommission(totalSale) itself is never credited to anyone —
    // the buyer is debited totalSale in full, the seller is credited only
    // marketSellerNet(totalSale) (= totalSale - the 5%), and nothing else
    // in this transaction touches gold. The difference is a pure sink.
    const sellerNet = marketSellerNet(totalSale);

    const buyerBalance = await debitGold(client, buyerId, totalSale, "market_buy");
    if (buyerBalance === null) return { ok: false, reason: "insufficient gold" };

    await creditGold(listing.seller_player_id, sellerNet, "market_sale", client);

    const remaining = listing.quantity - qty;
    if (remaining > 0) {
      await client.query(`UPDATE market_listings SET quantity = $1 WHERE id = $2`, [remaining, listingId]);
    } else {
      await client.query(`UPDATE market_listings SET status = 'sold', quantity = 0 WHERE id = $1`, [listingId]);
    }

    const nextCargo = cargoWithDelta(buyerShip.cargo, listing.commodity, qty);
    await client.query(`UPDATE ships SET cargo = $1::jsonb WHERE id = $2`, [JSON.stringify(nextCargo), buyerShip.id]);

    return { ok: true, cargo: nextCargo, gold: buyerBalance };
  });
}

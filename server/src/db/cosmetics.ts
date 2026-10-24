import { COSMETIC_NONE_KEY, cosmeticCost, isValidCosmeticChoice, type CosmeticSlot } from "@iron-tides/shared";
import { debitGold, withTransaction } from "./dock";

// Phase 7 (fifth/final slice): cosmetics purchase. Purely a gold debit +
// a column update — there are no stats to recompute, no ship row to
// touch, unlike every other dock purchase in db/dock.ts.
const SLOT_COLUMN: Record<CosmeticSlot, string> = {
  hullColor: "cosmetic_hull_color",
  sailPattern: "cosmetic_sail_pattern",
  flagColor: "cosmetic_flag_color",
  wakeColor: "cosmetic_wake_color",
};

export interface CosmeticPurchaseResult {
  ok: boolean;
  reason?: string;
  gold?: number;
}

export async function buyCosmetic(
  playerId: string,
  slot: CosmeticSlot,
  key: string
): Promise<CosmeticPurchaseResult> {
  if (!isValidCosmeticChoice(slot, key)) return { ok: false, reason: "unknown cosmetic option" };
  if (key === COSMETIC_NONE_KEY) return { ok: false, reason: "nothing to buy" };

  const cost = cosmeticCost(slot, key)!;
  // SLOT_COLUMN is a fixed internal whitelist, never user input, so this
  // interpolation is safe — same reasoning as every other place in this
  // codebase that builds a column name from a typed key rather than a
  // literal (e.g. OceanRoom.applyShipStats's upgrade fields).
  const column = SLOT_COLUMN[slot];

  return withTransaction(async (client) => {
    const balance = await debitGold(client, playerId, cost, "cosmetic_purchase");
    if (balance === null) return { ok: false, reason: "insufficient gold" };

    await client.query(`UPDATE players SET ${column} = $1 WHERE id = $2`, [key, playerId]);
    return { ok: true, gold: balance };
  });
}

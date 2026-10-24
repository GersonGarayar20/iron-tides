// Phase 7 (fifth/final slice): cosmetics. Purely visual — nothing in this
// file is ever consumed by computeShipStats (shared/src/upgrades.ts), and
// nothing here reads/writes maxHull/maxSpeed/turnRate/cannonsPerSide/
// reloadSeconds/cannonDamage/cargoCapacity. Each slot has a "none" option
// (free, the pre-cosmetics look) plus a handful of purchasable presets.
// Buying a slot overwrites whatever that slot was set to before — there's
// no owned-cosmetics inventory to switch back into for free, same
// "keep it simple, flat one-time cost" spirit as clan creation.
export type CosmeticSlot = "hullColor" | "sailPattern" | "flagColor" | "wakeColor";

export const COSMETIC_SLOTS: CosmeticSlot[] = ["hullColor", "sailPattern", "flagColor", "wakeColor"];

export const COSMETIC_NONE_KEY = "none";

export interface CosmeticOption {
  key: string;
  name: string;
  cost: number;
  // Hex color string; the accent color for sailPattern, the tint for
  // hullColor/flagColor/wakeColor. Empty for the "none" option, which has
  // no visual of its own — it just means "the original un-cosmetic look".
  color: string;
}

export const HULL_COLOR_OPTIONS: Record<string, CosmeticOption> = {
  none: { key: "none", name: "Casco estándar", cost: 0, color: "" },
  crimson: { key: "crimson", name: "Carmesí", cost: 150, color: "#c0392b" },
  emerald: { key: "emerald", name: "Esmeralda", cost: 150, color: "#27ae60" },
  gold: { key: "gold", name: "Dorado", cost: 220, color: "#f1c40f" },
  violet: { key: "violet", name: "Violeta", cost: 150, color: "#8e44ad" },
  ebony: { key: "ebony", name: "Ébano", cost: 150, color: "#2c3e50" },
};

// "style" picks which simple Phaser-primitive shape the client overlays on
// the hull triangle — a stripe, a cross, or a row of dots — never an image
// asset (see client/src/scenes/OceanScene.ts's renderShipCosmetics).
export type SailPatternStyle = "none" | "stripe" | "cross" | "dots";

export interface SailPatternOption extends CosmeticOption {
  style: SailPatternStyle;
}

export const SAIL_PATTERN_OPTIONS: Record<string, SailPatternOption> = {
  none: { key: "none", name: "Vela lisa", cost: 0, color: "", style: "none" },
  stripe: { key: "stripe", name: "Franja", cost: 120, color: "#ffd166", style: "stripe" },
  cross: { key: "cross", name: "Cruz", cost: 180, color: "#4fd8ff", style: "cross" },
  dots: { key: "dots", name: "Lunares", cost: 180, color: "#ff6b9d", style: "dots" },
};

// Reuses the exact banner-shape rendering already built for clan flags
// (two stacked color rects above the ship), just attached to a player
// instead of a clan, and with a single color rather than clans' optional
// two. Hidden client-side while the player is also flying a clan flag, so
// the two never visually overlap — see renderNameAndClanLabels.
export const FLAG_COLOR_OPTIONS: Record<string, CosmeticOption> = {
  none: { key: "none", name: "Sin bandera", cost: 0, color: "" },
  scarlet: { key: "scarlet", name: "Escarlata", cost: 100, color: "#e63946" },
  azure: { key: "azure", name: "Azur", cost: 100, color: "#457b9d" },
  jet: { key: "jet", name: "Negra", cost: 100, color: "#1d1d1d" },
  ivory: { key: "ivory", name: "Marfil", cost: 100, color: "#f1faee" },
};

// No movement trail/particle effect exists anywhere in the client yet
// (checked: only cannonballs have a trail, see CANNONBALL_TRAIL_LENGTH in
// OceanScene.ts) — ships with "none" render exactly as before (no trail at
// all), and only a purchased wake color adds one, so default behavior for
// every non-purchasing ship is byte-for-byte unchanged.
export const WAKE_COLOR_OPTIONS: Record<string, CosmeticOption> = {
  none: { key: "none", name: "Sin estela", cost: 0, color: "" },
  foam: { key: "foam", name: "Espuma", cost: 130, color: "#d9e8ef" },
  ember: { key: "ember", name: "Brasa", cost: 160, color: "#ff7849" },
  toxic: { key: "toxic", name: "Tóxica", cost: 160, color: "#9ef01a" },
};

export const COSMETIC_CATALOG: Record<CosmeticSlot, Record<string, CosmeticOption>> = {
  hullColor: HULL_COLOR_OPTIONS,
  sailPattern: SAIL_PATTERN_OPTIONS,
  flagColor: FLAG_COLOR_OPTIONS,
  wakeColor: WAKE_COLOR_OPTIONS,
};

export function isValidCosmeticChoice(slot: CosmeticSlot, key: string): boolean {
  return key in COSMETIC_CATALOG[slot];
}

// Null means "unknown option" (caller should already have validated via
// isValidCosmeticChoice — this is the authoritative price lookup for the
// actual debit).
export function cosmeticCost(slot: CosmeticSlot, key: string): number | null {
  const option = COSMETIC_CATALOG[slot][key];
  return option ? option.cost : null;
}

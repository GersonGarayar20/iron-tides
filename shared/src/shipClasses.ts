import {
  BOSS_MAX_HULL,
  CANNON_RELOAD_SECONDS,
  CANNONS_PER_SIDE,
  MAX_HULL,
  MAX_SPEED,
  TURN_RATE,
} from "./constants";

export type ShipClassKey = "balandra" | "bergantin" | "galeon" | "mercante" | "bot-default" | "boss";

export interface ShipClassDef {
  key: ShipClassKey;
  name: string;
  // Gold cost at the shipyard; 0 for the free starter class and for the
  // bot-only class, which is never purchasable.
  price: number;
  maxHull: number;
  maxSpeed: number;
  turnRate: number;
  cannonsPerSide: number;
  reloadSeconds: number;
  maxAmmo: number;
  // Phase 7 (second slice): base cargo hold before any Bodega upgrade
  // levels — see shared/src/upgrades.ts's computeShipStats.
  cargoCapacity: number;
  // Combat/collision hit-circle radius for this class — see hitRadiusFor
  // below for how each value was derived. Used by server/src/rooms/
  // OceanRoom.ts's findCannonballTarget (combat hit detection) and
  // findTouchingRock/resolveIslandCollisions (ship-vs-terrain collision),
  // replacing the old flat SHIP_HIT_RADIUS that every class used to share
  // regardless of its actual sprite size.
  hitRadius: number;
}

// Per-class hit-circle radius, derived from each class's real rendered hull
// footprint (not an arbitrary guess) — see client/src/scenes/OceanScene.ts's
// SHIP_CLASS_VISUALS (player classes) / PIRATE_SHIP_FRAMES/
// MERCHANT_SHIP_FRAMES/BOSS_SHIP_FRAME (bots/boss) and the hull atlas frame
// sizes in client/public/assets/pirates/ships/shipsMiscellaneous_sheet.xml:
//   - hullSmall frames are 40w x 108h; hullLarge are 50w x 108h.
//   - the bots'/boss's complete "ship (N).png" frame is 66w x 113h.
// Each class renders its hull at its own Container/Image scale, giving the
// rendered width/height fed into hitRadiusFor below.
//
// Formula: radius = max(renderedWidth, renderedHeight) / 2 * HIT_RADIUS_SHRINK.
// Half of the longer rendered dimension puts the circle's edge at the
// hull's actual bow/stern tip — the hull tapers to a point along its
// length, so that tip really is that far from the ship's center, which is
// exactly why a flat 22px radius made a cannonball that visually clipped a
// big ship's bow/stern still register as a miss. HIT_RADIUS_SHRINK then
// trims back the one place a length-based radius overshoots: sideways,
// across the hull's much narrower beam, where a full lengthwise radius
// would be too generous. 0.85 was chosen and then checked against real
// gameplay screenshots at every class (see the phase verification) —
// hits at the bow/stern of a Galeón and a Balandra both now land where
// they visually should, without the circle ballooning past either ship's
// sides.
const HIT_RADIUS_SHRINK = 0.85;

function hitRadiusFor(renderedWidth: number, renderedHeight: number): number {
  return Math.round(Math.max(renderedWidth, renderedHeight) * 0.5 * HIT_RADIUS_SHRINK * 10) / 10;
}

export const SHIP_CLASSES: Record<ShipClassKey, ShipClassDef> = {
  // Identical to the original Phase 1-3 constants so pirate/merchant bots
  // keep their exact movement, hull, reload and broadside feel unchanged.
  "bot-default": {
    key: "bot-default",
    name: "Bot Default",
    price: 0,
    maxHull: MAX_HULL,
    maxSpeed: MAX_SPEED,
    turnRate: TURN_RATE,
    cannonsPerSide: CANNONS_PER_SIDE,
    reloadSeconds: CANNON_RELOAD_SECONDS,
    maxAmmo: Number.MAX_SAFE_INTEGER,
    cargoCapacity: 0,
    // Complete "ship (N).png" frame, 66x113, rendered at scale 1 (no
    // setScale call for a non-boss npc in createShipNode).
    hitRadius: hitRadiusFor(66, 113),
  },
  // Starter class: fast and agile but fragile, free for every new player.
  balandra: {
    key: "balandra",
    name: "Balandra",
    price: 0,
    maxHull: 80,
    maxSpeed: 240,
    turnRate: 2.0,
    cannonsPerSide: 2,
    reloadSeconds: 3.5,
    maxAmmo: 40,
    cargoCapacity: 30,
    // hullSmall (40x108) at scale 0.85 -> 34x91.8 rendered.
    hitRadius: hitRadiusFor(40 * 0.85, 108 * 0.85),
  },
  // Mid-tier, balanced across every axis.
  bergantin: {
    key: "bergantin",
    name: "Bergantín",
    price: 500,
    maxHull: 140,
    maxSpeed: 210,
    turnRate: 1.5,
    cannonsPerSide: 3,
    reloadSeconds: 4.0,
    maxAmmo: 60,
    cargoCapacity: 60,
    // hullSmall (40x108) at scale 1.0 -> 40x108 rendered (unscaled).
    hitRadius: hitRadiusFor(40, 108),
  },
  // Heavy tank: slow and sluggish to turn, but hits hard and soaks damage.
  galeon: {
    key: "galeon",
    name: "Galeón",
    price: 1500,
    maxHull: 220,
    maxSpeed: 180,
    turnRate: 1.1,
    cannonsPerSide: 4,
    reloadSeconds: 4.5,
    maxAmmo: 90,
    cargoCapacity: 90,
    // hullLarge (50x108) at scale 1.25 -> 62.5x135 rendered — the biggest
    // player hitbox, matching it being the biggest player sprite.
    hitRadius: hitRadiusFor(50 * 1.25, 108 * 1.25),
  },
  // Phase 7 (second slice): the plan's dedicated trade hauler — "bodega
  // enorme" / weak combat. Priced between Bergantín and Galeón (a real
  // investment, not a starter option), with the weakest hull/cannons/turn
  // of any purchasable class but far more than double the Galeón's cargo
  // hold — the whole point of adding it now that commodity cargo exists.
  mercante: {
    key: "mercante",
    name: "Mercante",
    price: 800,
    maxHull: 100,
    maxSpeed: 190,
    turnRate: 1.0,
    cannonsPerSide: 1,
    reloadSeconds: 5.0,
    maxAmmo: 50,
    cargoCapacity: 250,
    // hullLarge (50x108) at scale 1.1 -> 55x118.8 rendered.
    hitRadius: hitRadiusFor(50 * 1.1, 108 * 1.1),
  },
  // Phase 7 (fourth slice): the weekend-event boss. Never purchasable (see
  // PURCHASABLE_CLASSES below) — spawned directly by OceanRoom, same as
  // bot-default. Slow and sluggish to turn (a "giant ship", not a nimble
  // one) but with hull far above the Galeón's and more cannons per side;
  // cannonDamage is overridden directly to BOSS_CANNON_DAMAGE after spawn
  // since computeShipStats's damage formula is class-independent (see
  // OceanRoom.spawnBot) — maxAmmo is effectively infinite like bot-default
  // since bots never draw from a finite ammo stock (see OceanRoom.tryFire).
  boss: {
    key: "boss",
    name: "Jefe",
    price: 0,
    maxHull: BOSS_MAX_HULL,
    maxSpeed: 140,
    turnRate: 0.6,
    cannonsPerSide: 5,
    reloadSeconds: 4.5,
    maxAmmo: Number.MAX_SAFE_INTEGER,
    cargoCapacity: 0,
    // Same complete "ship (N).png" frame as bot-default (66x113), but
    // rendered at scale 1.8 (see createShipNode's `if (isBoss)
    // image.setScale(1.8)`) -> 118.8x203.4 rendered — by far the largest
    // hitbox of any ship, matching it being by far the largest sprite.
    hitRadius: hitRadiusFor(66 * 1.8, 113 * 1.8),
  },
};

export const STARTER_SHIP_CLASS: ShipClassKey = "balandra";

const PURCHASABLE_CLASSES = new Set<string>(["balandra", "bergantin", "galeon", "mercante"]);

export function isPurchasableShipClass(key: string): key is Exclude<ShipClassKey, "bot-default" | "boss"> {
  return PURCHASABLE_CLASSES.has(key);
}

// The largest per-class hitRadius across every class (currently the
// boss). Used as the generic, ship-identity-agnostic safety margin for
// world-boundary logic (shared/src/world.ts's clampToWorldBounds/
// detectBorderCrossing) — a fixed value sized to the biggest ship so that
// *no* ship, regardless of class, can ever clip past a map edge, rather
// than threading each ship's own class-specific radius through every
// boundary check (those checks run every tick for every ship and aren't
// tied to one ship's identity the way combat/terrain collision are — see
// the Phase report for the reasoning).
export const MAX_SHIP_HIT_RADIUS = Math.max(...Object.values(SHIP_CLASSES).map((c) => c.hitRadius));

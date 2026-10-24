import { CANNON_DAMAGE } from "./constants";
import { SHIP_CLASSES, type ShipClassKey } from "./shipClasses";

// The 6 mechanically-grounded upgrades from Phase 4, plus Bodega (cargo
// capacity) added in Phase 7's second slice now that a commodity/cargo
// system exists for it to attach to. "Catalejo" (vision range) from the
// plan's table is still deliberately skipped: there's no interest-
// management/vision-culling system to attach it to yet.
export type UpgradeKey = "hull" | "sails" | "helm" | "cannons" | "gunPorts" | "gunners" | "bodega";

export type UpgradeLevels = Partial<Record<UpgradeKey, number>>;

export const ZERO_UPGRADES: Record<UpgradeKey, number> = {
  hull: 0,
  sails: 0,
  helm: 0,
  cannons: 0,
  gunPorts: 0,
  gunners: 0,
  bodega: 0,
};

export interface UpgradeDef {
  key: UpgradeKey;
  name: string;
  baseCost: number;
  // Applied as `base +/- level * increment` in computeShipStats below.
  increment: number;
}

// Cost scales x1.5 per level, as specified by the plan.
const COST_SCALING_PER_LEVEL = 1.5;
const MIN_RELOAD_SECONDS = 1.2;

export const UPGRADE_DEFS: Record<UpgradeKey, UpgradeDef> = {
  hull: { key: "hull", name: "Casco reforzado", baseCost: 100, increment: 15 },
  sails: { key: "sails", name: "Velas", baseCost: 100, increment: 10 },
  helm: { key: "helm", name: "Timón", baseCost: 90, increment: 0.15 },
  cannons: { key: "cannons", name: "Cañones", baseCost: 120, increment: 3 },
  gunPorts: { key: "gunPorts", name: "Portas de cañón", baseCost: 400, increment: 1 },
  gunners: { key: "gunners", name: "Artilleros", baseCost: 150, increment: 0.3 },
  // Phase 7 (second slice): +15 cargo capacity per level, same x1.5
  // cost-scaling as every other upgrade (see costForUpgradeLevel below).
  bodega: { key: "bodega", name: "Bodega", baseCost: 80, increment: 15 },
};

// Per-class max level for each upgrade. The starter ship caps lower across
// the board so a committed player eventually has to buy a bigger hull
// instead of grinding a starter ship to the same ceiling forever. Mercante
// mirrors that shape on the cargo axis specifically: a far higher Bodega
// cap than any combat class, but the lowest combat-upgrade caps of any
// purchasable class, matching its "huge cargo, weak combat" role.
export const UPGRADE_CAPS_BY_CLASS: Record<ShipClassKey, Record<UpgradeKey, number>> = {
  "bot-default": { hull: 0, sails: 0, helm: 0, cannons: 0, gunPorts: 0, gunners: 0, bodega: 0 },
  // Phase 7 (fourth slice): the boss is spawned directly with fixed stats
  // (see OceanRoom.spawnBot) and never buys upgrades, same as bot-default.
  boss: { hull: 0, sails: 0, helm: 0, cannons: 0, gunPorts: 0, gunners: 0, bodega: 0 },
  balandra: { hull: 4, sails: 5, helm: 5, cannons: 4, gunPorts: 1, gunners: 4, bodega: 4 },
  bergantin: { hull: 6, sails: 6, helm: 6, cannons: 6, gunPorts: 2, gunners: 6, bodega: 6 },
  galeon: { hull: 10, sails: 8, helm: 7, cannons: 8, gunPorts: 3, gunners: 8, bodega: 8 },
  mercante: { hull: 5, sails: 5, helm: 4, cannons: 3, gunPorts: 1, gunners: 3, bodega: 12 },
};

// Cost to buy `level` (i.e. to go from level-1 to level); level is 1-based.
export function costForUpgradeLevel(def: UpgradeDef, level: number): number {
  return Math.round(def.baseCost * COST_SCALING_PER_LEVEL ** (level - 1));
}

export interface ShipStats {
  maxHull: number;
  maxSpeed: number;
  turnRate: number;
  cannonsPerSide: number;
  reloadSeconds: number;
  cannonDamage: number;
  maxAmmo: number;
  cargoCapacity: number;
}

// Single source of truth for a ship's effective combat/movement stats, used
// identically by the server (authoritative) and the client (dock UI cost
// previews). Ammo capacity is a class property, not an upgrade, in this
// phase.
export function computeShipStats(classKey: ShipClassKey, upgrades: UpgradeLevels): ShipStats {
  const base = SHIP_CLASSES[classKey];
  const hull = upgrades.hull ?? 0;
  const sails = upgrades.sails ?? 0;
  const helm = upgrades.helm ?? 0;
  const cannons = upgrades.cannons ?? 0;
  const gunPorts = upgrades.gunPorts ?? 0;
  const gunners = upgrades.gunners ?? 0;
  const bodega = upgrades.bodega ?? 0;

  return {
    maxHull: base.maxHull + hull * UPGRADE_DEFS.hull.increment,
    maxSpeed: base.maxSpeed + sails * UPGRADE_DEFS.sails.increment,
    turnRate: base.turnRate + helm * UPGRADE_DEFS.helm.increment,
    cannonsPerSide: base.cannonsPerSide + gunPorts * UPGRADE_DEFS.gunPorts.increment,
    reloadSeconds: Math.max(
      MIN_RELOAD_SECONDS,
      base.reloadSeconds - gunners * UPGRADE_DEFS.gunners.increment
    ),
    cannonDamage: CANNON_DAMAGE + cannons * UPGRADE_DEFS.cannons.increment,
    maxAmmo: base.maxAmmo,
    cargoCapacity: base.cargoCapacity + bodega * UPGRADE_DEFS.bodega.increment,
  };
}

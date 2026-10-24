import { MapSchema, Schema, type } from "@colyseus/schema";
import { computeShipStats, STARTER_SHIP_CLASS, ZERO_UPGRADES } from "@iron-tides/shared";

const DEFAULT_STATS = computeShipStats(STARTER_SHIP_CLASS, ZERO_UPGRADES);

export class ShipSchema extends Schema {
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") heading = 0;
  @type("number") speed = 0;
  @type("number") hull = DEFAULT_STATS.maxHull;
  @type("number") maxHull = DEFAULT_STATS.maxHull;
  @type("boolean") sunk = false;
  @type("number") portReloadRemaining = 0;
  @type("number") starboardReloadRemaining = 0;
  // Mirrors players.gold in Postgres; see OceanRoom for how it stays synced.
  @type("number") gold = 0;
  // "player" for real clients; "pirate"/"merchant" for AI-driven ships.
  @type("string") kind = "player";
  // Only meaningful while kind !== "player"; empty for real players.
  @type("string") aiState = "";

  // Phase 4: class + upgrades drive these per-ship combat/movement stats.
  // Bots use "bot-default" with every upgrade at 0, which reproduces the
  // exact Phase 1-3 constants, so their behavior is unchanged.
  @type("string") shipClass = STARTER_SHIP_CLASS;
  @type("number") maxSpeed = DEFAULT_STATS.maxSpeed;
  @type("number") turnRate = DEFAULT_STATS.turnRate;
  @type("number") cannonsPerSide = DEFAULT_STATS.cannonsPerSide;
  @type("number") reloadSeconds = DEFAULT_STATS.reloadSeconds;
  @type("number") cannonDamage = DEFAULT_STATS.cannonDamage;
  @type("number") ammo = DEFAULT_STATS.maxAmmo;
  @type("number") maxAmmo = DEFAULT_STATS.maxAmmo;

  // Upgrade levels, synced so the client's dock UI can derive next-level
  // cost/cap from the shared pure functions without a server round-trip.
  @type("number") upgradeHull = 0;
  @type("number") upgradeSails = 0;
  @type("number") upgradeHelm = 0;
  @type("number") upgradeCannons = 0;
  @type("number") upgradeGunPorts = 0;
  @type("number") upgradeGunners = 0;
  @type("number") upgradeBodega = 0;

  // Phase 7 (second slice): commodity cargo. Four explicit fields rather
  // than a MapSchema, matching the per-upgrade-field style above — there
  // are exactly 4 fixed commodities (see shared/src/commodities.ts), same
  // reasoning as the upgrade levels being individual fields instead of a map.
  @type("number") cargoCapacity = DEFAULT_STATS.cargoCapacity;
  @type("number") cargoRon = 0;
  @type("number") cargoEspecias = 0;
  @type("number") cargoSeda = 0;
  @type("number") cargoMadera = 0;

  // Phase 6: name/reputation/clan mirrors. All plain mirrors of the
  // players/clans rows, refreshed by OceanRoom whenever the underlying DB
  // value changes — see syncShipFromPlayer / refreshClanState.
  @type("string") displayName = "";
  // Mirrors players.created_at (epoch ms) — the single piece of state
  // isNoviceProtected (shared/src/reputation.ts) needs.
  @type("number") createdAtMs = 0;
  @type("number") honor = 0;
  @type("number") bounty = 0;
  // 0 means "not currently flagged"; isPirateFlagged is the pure source of
  // truth for "is this still active right now".
  @type("number") pirateFlagUntilMs = 0;
  // Empty string means "not in a clan".
  @type("string") clanTag = "";
  @type("string") clanColor1 = "";
  @type("string") clanColor2 = "";

  // Phase 7 (fifth/final slice): cosmetics. Plain mirrors of the
  // players.cosmetic_* columns, same "copy onto the ship schema at join,
  // refresh after a mutating action" discipline as the clan fields just
  // above — see OceanRoom.applyCosmeticMirror. "none" (COSMETIC_NONE_KEY)
  // means "no purchase for this slot yet" — renders exactly like a player
  // who never bought any cosmetics. Purely visual: never read by
  // computeShipStats or anything else in shared/src/upgrades.ts.
  @type("string") cosmeticHullColor = "none";
  @type("string") cosmeticSailPattern = "none";
  @type("string") cosmeticFlagColor = "none";
  @type("string") cosmeticWakeColor = "none";
}

export class CannonballSchema extends Schema {
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") vx = 0;
  @type("number") vy = 0;
  @type("string") ownerId = "";
  // Snapshot of the shooter's cannonDamage at fire time, so a later class
  // switch or upgrade purchase can't retroactively change an in-flight
  // ball's damage.
  @type("number") damage = 0;
}

export class LootSchema extends Schema {
  @type("number") x = 0;
  @type("number") y = 0;
  // Phase 7 (second slice): empty string = plain gold loot (Phase 2/3
  // behavior, unchanged). Non-empty = scavengable cargo lost by a sunk
  // player ship — see OceanRoom.handleCargoLossOnSink / awardCargoLoot.
  @type("string") commodity = "";
  @type("number") qty = 0;
}

export class OceanState extends Schema {
  @type({ map: ShipSchema }) ships = new MapSchema<ShipSchema>();
  @type({ map: CannonballSchema }) cannonballs = new MapSchema<CannonballSchema>();
  @type({ map: LootSchema }) loot = new MapSchema<LootSchema>();

  // Phase 7 (first slice): which region+channel this room instance is.
  // Synced via normal schema state (not a message) specifically so it's
  // guaranteed present on the very first state snapshot — no race with the
  // client wiring up onMessage handlers after the join/transfer resolves.
  @type("string") regionId = "";
  @type("number") channel = 1;

  // Phase 7 (fourth slice): mirrors server/src/weekendEvent.ts's
  // isWeekendEventActive(), recomputed every tick (see OceanRoom.tick) —
  // synced via schema state rather than a message for the exact same
  // "guaranteed present on the first snapshot" reason regionId/channel are.
  @type("boolean") weekendEventActive = false;
}

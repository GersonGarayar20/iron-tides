import { matchMaker, Room, ServerError, type Client } from "@colyseus/core";
import {
  ACCELERATION,
  BOSS_CANNON_DAMAGE,
  BOSS_GOLD_REWARD,
  BOSS_RESPAWN_COOLDOWN_SECONDS,
  BOSS_SPAWN_POINT,
  BOSS_VOLLEY_BALL_COUNT,
  BOSS_VOLLEY_DAMAGE,
  BOSS_VOLLEY_INTERVAL_SECONDS,
  BOT_GOLD_REWARD_MERCHANT,
  BOT_GOLD_REWARD_PIRATE,
  BOT_RESPAWN_MAX_SECONDS,
  BOT_RESPAWN_MIN_SECONDS,
  BOT_SPAWN_MIN_PLAYER_DISTANCE,
  BOT_TARGET_BASE_MERCHANTS,
  BOT_TARGET_BASE_PIRATES,
  BOT_TARGET_CAP_PER_KIND,
  BOT_TARGET_PER_PLAYER_MERCHANTS,
  BOT_TARGET_PER_PLAYER_PIRATES,
  BOUNTY_GAIN_PER_KILL,
  CANNON_ORIGIN_OFFSET,
  CANNON_SPACING,
  CANNONBALL_LIFETIME_SECONDS,
  CANNONBALL_SPEED,
  CHAT_MAX_MESSAGE_LENGTH,
  CHAT_RATE_LIMIT_MAX_MESSAGES,
  CHAT_RATE_LIMIT_WINDOW_SECONDS,
  CLAN_NAME_MAX_LENGTH,
  CLAN_TAG_MAX_LENGTH,
  clampToWorldBounds,
  computeShipStats,
  COMMODITY_KEYS,
  DEFAULT_REGION_CHANNEL_CAP,
  detectBorderCrossing,
  DOCK,
  DRAG,
  filterProfanity,
  findTouchingRock,
  generateCazaOffer,
  generateEscoltaOffer,
  generateExploracionOffer,
  getCannonFiringOrigin,
  getOmniVolleyDirections,
  getRegion,
  HONOR_GAIN_PIRATE_KILL,
  HONOR_LOSS_INNOCENT_KILL,
  isInSafeZone,
  isNoviceProtected,
  isPirateFlagged,
  isPurchasableShipClass,
  LOGIN_STREAK_CHEST_GOLD,
  LOGIN_STREAK_CHEST_INTERVAL,
  MAX_GROUP_SIZE,
  PIRATE_FLAG_DURATION_SECONDS,
  REVERSE_SPEED_FACTOR,
  resolveIslandCollisions,
  ROCK_DAMAGE_PER_SECOND,
  SHIP_CLASSES,
  stepCannonball,
  stepShip,
  totalCargoQuantity,
  TURN_ACCELERATION,
  UPGRADE_DEFS,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  type BorderCrossing,
  type BotAIState,
  type BotKind,
  type CannonSide,
  type CargoHold,
  type ChatChannel,
  type ChatMessage,
  type ClanRank,
  type CommodityKey,
  type CosmeticSlot,
  type EscoltaParams,
  type ExploracionParams,
  type MissionOffer,
  type MissionType,
  type RegionDef,
  type ShipClassKey,
  type ShipInput,
  type UpgradeKey,
} from "@iron-tides/shared";
import { decideBotAction, type BotRuntimeState, type PlayerCandidate } from "../ai/botAI";
import { verifyAuthToken } from "../auth/jwt";
import { insertChatReport } from "../db/chat";
import { isWeekendEventActive } from "../weekendEvent";
import * as directory from "../world/directory";
import * as groupsStore from "../world/groups";
import {
  canActOnClanAs,
  createClan,
  disbandClan,
  donateToBank,
  getClanForPlayer,
  getClanMembers,
  joinClan,
  kickClanMember,
  leaveClan,
  renameClan,
  setClanMemberRank,
  withdrawFromBank,
} from "../db/clans";
import {
  buyCommodity,
  clearShipCargo,
  grantShipCargo,
  listDockPrices,
  sellCommodity,
} from "../db/commodities";
import { buyAmmo, buyShip, buyUpgrade, creditGold, repairShip, switchActiveShip } from "../db/dock";
import { buyCosmetic } from "../db/cosmetics";
import { buyListing, cancelListing, createListing, listActiveListings } from "../db/market";
import { findPlayerById, type PlayerRow } from "../db/players";
import { adjustHonor, incrementBounty, payoutBounty, setPirateFlagIfUnflagged } from "../db/reputation";
import { getActiveShip, getShipsByPlayer, persistShipHull, type ShipRow } from "../db/ships";
import {
  claimDailyTask,
  completeMission,
  createMission,
  ensureDailyTasks,
  failMission,
  getActiveMissions,
  getTavernBundle,
  recordPlayerEvent,
  rerollDailyTask,
  updateLoginStreak,
  updateMissionProgress,
} from "../db/tavern";
import { CannonballSchema, LootSchema, OceanState, ShipSchema } from "../schema/OceanState";

const TICK_RATE_HZ = 20;
const DT_SECONDS = 1 / TICK_RATE_HZ;
const SPAWN_SPACING = 120;
const SPAWN_COLUMNS = 4;
const SPAWN_ROWS = 3;
const RESPAWN_DELAY_SECONDS = 5;
const LOOT_PICKUP_RADIUS = 30;
const LOOT_SPAWN_SPREAD = 60;
const BOT_SPAWN_ATTEMPTS = 30;
const AUTOSAVE_INTERVAL_SECONDS = 120;
const BOT_SHIP_CLASS: ShipClassKey = "bot-default";

// Phase 7 (first slice): region channel cap. REGION_CHANNEL_CAP lets
// verification override the realistic default down to e.g. 3 so a second
// channel actually opens without needing 150 real test connections — see
// shared/src/constants.ts's DEFAULT_REGION_CHANNEL_CAP comment.
const REGION_CHANNEL_CAP = (() => {
  const raw = Number(process.env.REGION_CHANNEL_CAP);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REGION_CHANNEL_CAP;
})();

// How long a border-crossing player's ship stays frozen in the source room
// while the cross-room seat reservation is in flight, before giving up and
// resuming normal (clamped) movement in place — a defensive fallback in
// case the reservation or the client's consume step never completes.
const TRANSFER_FREEZE_TIMEOUT_MS = 5000;

interface RoomAuthData {
  player: PlayerRow;
  ship: ShipRow;
  // Re-sent verbatim to matchMaker.joinOrCreate when this player later
  // border-crosses into a neighboring region's room (see
  // beginRegionTransfer) — onAuth there needs the same proof of identity,
  // and OceanRoom never stores a client's raw JWT anywhere else.
  token: string;
}

interface PlayerSessionInfo {
  playerId: string;
  shipId: string;
  token: string;
  wasInSafeZone: boolean;
}

// The live ship snapshot carried across a border-crossing transfer so hull/
// ammo/gold/position/heading/speed survive exactly, without waiting on the
// DB writes that normally only happen at safe-zone-entry/autosave/leave
// (ammo in particular is never persisted mid-session otherwise).
interface RegionTransferPayload {
  shipId: string;
  x: number;
  y: number;
  heading: number;
  speed: number;
  hull: number;
  ammo: number;
  gold: number;
}

// Phase 5: the subset of an active Escolta/Exploración mission that needs a
// per-tick check (bot-alive / position-vs-radius). Caza missions need no
// cache entry — their progress is entirely event-driven, bumped by
// recordPlayerEvent on bot_sunk.
interface CachedTrackedMission {
  id: string;
  progress: number;
  target: number;
  params: EscoltaParams | ExploracionParams;
}

interface ActiveMissionCache {
  escolta?: CachedTrackedMission;
  exploracion?: CachedTrackedMission;
}

interface PendingGroupInvite {
  groupId: string;
  inviterId: string;
  expiresAt: number;
}

interface PendingClanInvite {
  clanId: string;
  inviterId: string;
  expiresAt: number;
}

const INVITE_EXPIRY_MS = 30_000;

function sanitizeAxis(value: unknown): -1 | 0 | 1 {
  const n = Number(value);
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}

function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export class OceanRoom extends Room<OceanState, unknown, unknown, RoomAuthData> {
  private lastInputs = new Map<string, ShipInput>();
  private spawnPoints = new Map<string, { x: number; y: number }>();
  private respawnRemaining = new Map<string, number>();
  private cannonballAge = new Map<string, number>();
  private spawnCount = 0;
  private cannonballCount = 0;
  private lootCount = 0;

  // Phase 4: maps a connected player's sessionId to their DB identity, so
  // combat/dock/save code can persist without re-deriving it every time.
  private playerSessions = new Map<string, PlayerSessionInfo>();
  private autosaveAccumulator = 0;

  private botRuntimes = new Map<string, BotRuntimeState>();
  // botId -> attackerId -> accumulated damage, used to split the gold
  // reward proportionally when a bot is sunk by more than one player.
  private botDamageContributions = new Map<string, Map<string, number>>();
  private botSpawnCount = 0;
  private botRespawnTimers = new Map<BotKind, number>([
    ["pirate", 2],
    ["merchant", 2],
  ]);

  // Phase 7 (fourth slice): weekend-event boss. One slot per room instance
  // (same per-room granularity every other bot already spawns at — see
  // tickBossSpawning). bossVolleyTimers is keyed by bot id like every
  // other per-bot map above; the cooldown is a single number since there's
  // only ever at most one boss in this room.
  private bossVolleyTimers = new Map<string, number>();
  private bossRespawnCooldownRemaining = 0;

  // Phase 5: Tavern (missions/daily tasks/streak/achievements/ranking).
  // Mission offers are generated in-memory per session rather than
  // persisted — they're just a board of things the player *could* accept;
  // only an accepted mission becomes a `missions` row.
  private missionOffers = new Map<string, MissionOffer[]>();
  private activeMissionCache = new Map<string, ActiveMissionCache>();

  // Phase 6: social. displayNames mirrors players.display_name for the
  // handful of places that need a human-readable name without an extra
  // query (chat, invites). Chat rate limiting, groups, and clan-membership
  // caching are all per-room, in-memory state — clan membership itself is
  // DB-persisted, but which *session* currently represents which clan
  // member is inherently connection-scoped, same as playerSessions.
  private displayNames = new Map<string, string>();
  private chatTimestamps = new Map<string, number[]>();

  // Phase 7 (first slice): group membership itself moved to a process-wide
  // module (server/src/world/groups.ts) keyed by persistent playerId, since
  // a member can now border-cross into a different room than the one they
  // were invited in. pendingGroupInvites stays per-room/session-scoped —
  // inviting is still only ever done against a currently-visible nearby
  // ship (see client's nearbyPlayers()), which is inherently same-room.
  private pendingGroupInvites = new Map<string, PendingGroupInvite>();

  private sessionClanId = new Map<string, string | null>();
  private pendingClanInvites = new Map<string, PendingClanInvite>();

  // Phase 7 (first slice): which region+channel this room instance is —
  // set once in onCreate and never changed for the room's lifetime.
  private regionId!: string;
  private region!: RegionDef;
  private channel!: number;
  private roomKey!: string;

  // sessionId -> epoch ms deadline. Set the instant a border crossing is
  // detected (freezes that ship in tickShipMovement while the cross-room
  // seat reservation is in flight) and cleared once the transfer completes
  // (the session leaves this room) or the deadline elapses (safety thaw).
  private transferringUntil = new Map<string, number>();

  onCreate(options?: { regionId?: string }) {
    this.region = getRegion(options?.regionId);
    this.regionId = this.region.id;
    this.channel = directory.nextChannelNumber(this.regionId);
    this.roomKey = directory.roomKeyFor(this.regionId, this.channel);
    this.maxClients = REGION_CHANNEL_CAP;
    directory.registerRoom(this.roomKey, this);

    this.setState(new OceanState());
    this.state.regionId = this.regionId;
    this.state.channel = this.channel;

    this.onMessage("input", (client, message: ShipInput) => {
      this.lastInputs.set(client.sessionId, {
        throttle: sanitizeAxis(message?.throttle),
        turn: sanitizeAxis(message?.turn),
      });
    });

    this.onMessage("fire", (client, message: { side?: CannonSide }) => {
      this.handleFire(client, message?.side === "starboard" ? "starboard" : "port");
    });

    this.onMessage("dock:listShips", (client) => this.handleListShips(client));
    this.onMessage("dock:buyShip", (client, message: { classKey?: string }) =>
      this.handleBuyShip(client, message)
    );
    this.onMessage("dock:switchShip", (client, message: { shipId?: string }) =>
      this.handleSwitchShip(client, message)
    );
    this.onMessage("dock:repair", (client) => this.handleRepair(client));
    this.onMessage("dock:buyAmmo", (client) => this.handleBuyAmmo(client));
    this.onMessage("dock:buyUpgrade", (client, message: { key?: string }) =>
      this.handleBuyUpgrade(client, message)
    );

    this.onMessage("dock:listPrices", (client) => this.handleListPrices(client));
    this.onMessage("dock:buyCargo", (client, message: { commodity?: string; quantity?: number }) =>
      this.handleBuyCargo(client, message)
    );
    this.onMessage("dock:sellCargo", (client, message: { commodity?: string; quantity?: number }) =>
      this.handleSellCargo(client, message)
    );

    // Phase 7 (fifth/final slice): player-to-player market + cosmetics.
    this.onMessage("market:listListings", (client) => this.handleListMarketListings(client));
    this.onMessage(
      "market:createListing",
      (client, message: { commodity?: string; quantity?: number; pricePerUnit?: number }) =>
        this.handleCreateListing(client, message)
    );
    this.onMessage("market:cancelListing", (client, message: { listingId?: string }) =>
      this.handleCancelListing(client, message)
    );
    this.onMessage("market:buyListing", (client, message: { listingId?: string; quantity?: number }) =>
      this.handleBuyListing(client, message)
    );
    this.onMessage("cosmetics:buy", (client, message: { slot?: string; key?: string }) =>
      this.handleBuyCosmetic(client, message)
    );

    this.onMessage("tavern:open", (client) => this.handleTavernOpen(client));
    this.onMessage("tavern:refresh", (client) => this.handleTavernRefresh(client));
    this.onMessage("tavern:acceptMission", (client, message: { slot?: number }) =>
      this.handleAcceptMission(client, message)
    );
    this.onMessage("tavern:claimDailyTask", (client, message: { taskId?: string }) =>
      this.handleClaimDailyTask(client, message)
    );
    this.onMessage("tavern:rerollDailyTask", (client, message: { taskId?: string }) =>
      this.handleRerollDailyTask(client, message)
    );

    this.onMessage("chat:send", (client, message: { channel?: ChatChannel; text?: string }) =>
      this.handleChatSend(client, message)
    );
    this.onMessage("chat:report", (client, message: { reportedPlayerId?: string; text?: string }) =>
      this.handleChatReport(client, message)
    );

    this.onMessage("group:invite", (client, message: { targetSessionId?: string }) =>
      this.handleGroupInvite(client, message)
    );
    this.onMessage("group:respond", (client, message: { accept?: boolean }) =>
      this.handleGroupRespond(client, message)
    );
    this.onMessage("group:leave", (client) => this.handleGroupLeave(client));
    this.onMessage("group:kick", (client, message: { targetPlayerId?: string }) =>
      this.handleGroupKick(client, message)
    );
    this.onMessage("group:disband", (client) => this.handleGroupDisband(client));

    this.onMessage("clan:create", (client, message: Record<string, unknown>) =>
      this.handleClanCreate(client, message)
    );
    this.onMessage("clan:invite", (client, message: { targetSessionId?: string }) =>
      this.handleClanInvite(client, message)
    );
    this.onMessage("clan:respond", (client, message: { accept?: boolean }) =>
      this.handleClanRespond(client, message)
    );
    this.onMessage("clan:rename", (client, message: { name?: string }) => this.handleClanRename(client, message));
    this.onMessage("clan:disband", (client) => this.handleClanDisband(client));
    this.onMessage("clan:leave", (client) => this.handleClanLeave(client));
    this.onMessage("clan:kick", (client, message: { targetPlayerId?: string }) =>
      this.handleClanKick(client, message)
    );
    this.onMessage("clan:promote", (client, message: { targetPlayerId?: string }) =>
      this.handleClanSetRank(client, message, "oficial")
    );
    this.onMessage("clan:demote", (client, message: { targetPlayerId?: string }) =>
      this.handleClanSetRank(client, message, "marinero")
    );
    this.onMessage("clan:donate", (client, message: { amount?: number }) => this.handleClanDonate(client, message));
    this.onMessage("clan:withdraw", (client, message: { amount?: number }) =>
      this.handleClanWithdraw(client, message)
    );
    this.onMessage("clan:roster", (client) => this.handleClanRoster(client));

    // Simulation is the single authority; onMessage only records intent so
    // every ship advances in lockstep on the fixed tick below.
    this.setSimulationInterval(() => this.tick(), 1000 / TICK_RATE_HZ);
  }

  async onAuth(client: Client, options: any): Promise<RoomAuthData> {
    const token = options?.token;
    if (typeof token !== "string" || !token) {
      throw new ServerError(401, "missing auth token");
    }

    let payload;
    try {
      payload = verifyAuthToken(token);
    } catch {
      throw new ServerError(401, "invalid or expired auth token");
    }

    const player = await findPlayerById(payload.playerId);
    if (!player) throw new ServerError(401, "unknown player");

    const ship = await getActiveShip(player.id);
    if (!ship) throw new ServerError(500, "player has no active ship");

    return { player, ship, token };
  }

  onDispose() {
    directory.unregisterRoom(this.roomKey);
  }

  onJoin(client: Client, options: { transfer?: RegionTransferPayload } | undefined, auth: RoomAuthData) {
    const { player, ship: shipRow, token } = auth;
    const stats = computeShipStats(shipRow.class, shipRow.upgrades);

    // A border-crossing transfer (see beginRegionTransfer) carries the
    // exact live ship snapshot it left the previous region's room with —
    // hull/ammo in particular are never persisted to Postgres mid-session,
    // so a DB reload here would silently roll them back. Sanity-checked
    // against the authenticated player's own active ship id.
    const transfer = options?.transfer && options.transfer.shipId === shipRow.id ? options.transfer : null;

    const ship = new ShipSchema();
    // Wraps instead of growing rows forever, so the grid always stays well
    // inside the dock's safe-zone radius no matter how many joins the room
    // has seen. Always computed (even on a transfer-join) since it's also
    // this player's respawn point in *this* region if later sunk.
    const slot = this.spawnCount++ % (SPAWN_COLUMNS * SPAWN_ROWS);
    const col = slot % SPAWN_COLUMNS;
    const row = Math.floor(slot / SPAWN_COLUMNS);
    const dockSpawn = {
      x: DOCK.x + (col - (SPAWN_COLUMNS - 1) / 2) * SPAWN_SPACING,
      y: DOCK.y + (row - (SPAWN_ROWS - 1) / 2) * SPAWN_SPACING,
    };
    ship.x = transfer ? transfer.x : dockSpawn.x;
    ship.y = transfer ? transfer.y : dockSpawn.y;
    ship.heading = transfer ? transfer.heading : 0;
    ship.speed = transfer ? transfer.speed : 0;
    ship.kind = "player";

    this.applyShipStats(ship, shipRow.class, shipRow.upgrades, stats);
    ship.hull = Math.min(transfer ? transfer.hull : shipRow.hull, stats.maxHull);
    ship.ammo = Math.min(transfer ? transfer.ammo : shipRow.ammo, stats.maxAmmo);
    ship.gold = transfer ? transfer.gold : player.gold;
    // Cargo is never threaded through RegionTransferPayload like hull/ammo
    // are: every cargo change (buy/sell/scavenge) writes straight through to
    // Postgres immediately, same discipline as gold, so the fresh row this
    // onAuth call just fetched is always accurate — unlike ammo, nothing can
    // change it mid-flight between the border crossing and this join.
    this.applyCargoMirror(ship, shipRow.cargo);

    // Phase 6: reputation/name mirrors, read straight from the auth row so
    // no extra query is needed on join.
    ship.displayName = player.display_name;
    ship.createdAtMs = player.created_at.getTime();
    ship.honor = player.honor;
    ship.bounty = player.bounty;
    ship.pirateFlagUntilMs = player.pirate_flag_until ? player.pirate_flag_until.getTime() : 0;
    this.applyCosmeticMirror(ship, player);

    this.state.ships.set(client.sessionId, ship);
    this.lastInputs.set(client.sessionId, { throttle: 0, turn: 0 });
    this.spawnPoints.set(client.sessionId, dockSpawn);
    this.playerSessions.set(client.sessionId, {
      playerId: player.id,
      shipId: shipRow.id,
      token,
      wasInSafeZone: isInSafeZone(ship.x, ship.y),
    });
    this.displayNames.set(client.sessionId, player.display_name);

    directory.setPlayerLocation({
      playerId: player.id,
      sessionId: client.sessionId,
      regionId: this.regionId,
      channel: this.channel,
      roomKey: this.roomKey,
    });

    // Fire-and-forget: ship join already happened synchronously above, so
    // this never blocks the player entering the world. Covers "logs in"
    // for both the login streak and the daily-task reset — opening the
    // Tavern tab calls the same ensureDailyTasks idempotently.
    this.initTavernSession(client.sessionId, player.id).catch((err) => {
      console.error("[OceanRoom] failed to init tavern session", err);
    });

    // Also fire-and-forget: populates the clan tag/color mirror on the ship
    // and the sessionClanId cache chat uses to gate the clan channel.
    this.refreshClanState(client.sessionId, player.id).catch((err) => {
      console.error("[OceanRoom] failed to init clan state", err);
    });
  }

  async onLeave(client: Client, consented?: boolean) {
    const ship = this.state.ships.get(client.sessionId);
    const session = this.playerSessions.get(client.sessionId);
    if (ship && session) {
      try {
        await persistShipHull(session.shipId, ship.hull);
      } catch (err) {
        console.error("[OceanRoom] failed to persist hull on leave", err);
      }
    }

    this.state.ships.delete(client.sessionId);
    this.lastInputs.delete(client.sessionId);
    this.spawnPoints.delete(client.sessionId);
    this.respawnRemaining.delete(client.sessionId);
    this.transferringUntil.delete(client.sessionId);
    this.playerSessions.delete(client.sessionId);
    this.missionOffers.delete(client.sessionId);
    this.activeMissionCache.delete(client.sessionId);

    this.displayNames.delete(client.sessionId);
    this.chatTimestamps.delete(client.sessionId);
    this.sessionClanId.delete(client.sessionId);
    this.pendingClanInvites.delete(client.sessionId);
    this.pendingGroupInvites.delete(client.sessionId);

    if (session) directory.clearPlayerLocationIfSession(session.playerId, client.sessionId);

    // `consented === true` means the client itself called room.leave() —
    // in this codebase that only ever happens as the second half of a
    // border-crossing transfer (see OceanScene's handleRegionTransfer);
    // there's no explicit "quit" button. A real disconnect (closed tab,
    // dropped network) arrives with consented === false, so group
    // membership only gets torn down on an actual disconnect — a
    // transferring player's group must keep working once they land in
    // their new room. Clan membership needs no such guard: it lives in
    // Postgres, untouched by any of this.
    if (!consented && session) {
      this.removeFromGroup(session.playerId);
    }
  }

  // Writes every per-ship stat field in one place so onJoin / switchShip /
  // buyUpgrade can never let the schema drift from class + upgrade levels.
  private applyShipStats(
    ship: ShipSchema,
    classKey: ShipClassKey,
    upgrades: Partial<Record<UpgradeKey, number>>,
    stats: ReturnType<typeof computeShipStats>
  ) {
    ship.shipClass = classKey;
    ship.maxHull = stats.maxHull;
    ship.maxSpeed = stats.maxSpeed;
    ship.turnRate = stats.turnRate;
    ship.cannonsPerSide = stats.cannonsPerSide;
    ship.reloadSeconds = stats.reloadSeconds;
    ship.cannonDamage = stats.cannonDamage;
    ship.maxAmmo = stats.maxAmmo;
    ship.cargoCapacity = stats.cargoCapacity;
    ship.upgradeHull = upgrades.hull ?? 0;
    ship.upgradeSails = upgrades.sails ?? 0;
    ship.upgradeHelm = upgrades.helm ?? 0;
    ship.upgradeCannons = upgrades.cannons ?? 0;
    ship.upgradeGunPorts = upgrades.gunPorts ?? 0;
    ship.upgradeGunners = upgrades.gunners ?? 0;
    ship.upgradeBodega = upgrades.bodega ?? 0;
  }

  // Ship-hit-detection fix (graphics overhaul follow-up): every ship's
  // class is always written onto ship.shipClass by applyShipStats above
  // (bots/boss included — see spawnBot), so this is a straight lookup of
  // that class's real, sprite-size-derived hit-circle radius — see
  // shared/src/shipClasses.ts's SHIP_CLASSES[...].hitRadius. Used for both
  // combat hit detection (findCannonballTarget) and ship-vs-terrain
  // collision (applyRockDamage / tickShipMovement's resolveIslandCollisions
  // call) so a ship's physical footprint is the same thing in both places.
  private shipHitRadius(ship: ShipSchema): number {
    return SHIP_CLASSES[ship.shipClass as ShipClassKey].hitRadius;
  }

  // Phase 7 (second slice): reads the 4 mirrored cargo fields back into a
  // plain CargoHold — the shared pure cargo/pricing functions in
  // db/commodities.ts only ever see the plain type, never the schema.
  private cargoFromShip(ship: ShipSchema): CargoHold {
    return {
      ron: ship.cargoRon,
      especias: ship.cargoEspecias,
      seda: ship.cargoSeda,
      madera: ship.cargoMadera,
    };
  }

  private applyCargoMirror(ship: ShipSchema, cargo: CargoHold) {
    ship.cargoRon = cargo.ron ?? 0;
    ship.cargoEspecias = cargo.especias ?? 0;
    ship.cargoSeda = cargo.seda ?? 0;
    ship.cargoMadera = cargo.madera ?? 0;
  }

  // Phase 7 (fifth/final slice): cosmetics are columns on `players`
  // (persist across ship purchases/switches, same reasoning as honor/
  // clanTag living on the player rather than the ship), mirrored onto the
  // ship schema at join exactly like those other player-level fields —
  // see onJoin above and handleBuyCosmetic below for the only place they
  // change mid-session.
  private applyCosmeticMirror(ship: ShipSchema, player: PlayerRow) {
    ship.cosmeticHullColor = player.cosmetic_hull_color;
    ship.cosmeticSailPattern = player.cosmetic_sail_pattern;
    ship.cosmeticFlagColor = player.cosmetic_flag_color;
    ship.cosmeticWakeColor = player.cosmetic_wake_color;
  }

  private toShipRow(ship: ShipSchema, session: PlayerSessionInfo): ShipRow {
    return {
      id: session.shipId,
      player_id: session.playerId,
      class: ship.shipClass as ShipClassKey,
      upgrades: {
        hull: ship.upgradeHull,
        sails: ship.upgradeSails,
        helm: ship.upgradeHelm,
        cannons: ship.upgradeCannons,
        gunPorts: ship.upgradeGunPorts,
        gunners: ship.upgradeGunners,
        bodega: ship.upgradeBodega,
      },
      hull: ship.hull,
      ammo: ship.ammo,
      cargo: this.cargoFromShip(ship),
      is_active: true,
      created_at: new Date(),
    };
  }

  // Only usable while docked (inside the safe zone), reusing the same
  // isInSafeZone check combat and bot AI already rely on.
  private getDockedPlayerShip(
    client: Client
  ): { ship: ShipSchema; session: PlayerSessionInfo } | null {
    const ship = this.state.ships.get(client.sessionId);
    const session = this.playerSessions.get(client.sessionId);
    if (!ship || !session || ship.kind !== "player" || ship.sunk) return null;
    if (!isInSafeZone(ship.x, ship.y)) return null;
    return { ship, session };
  }

  private sendDockResult(client: Client, action: string, ok: boolean, reason?: string) {
    client.send("dockResult", { action, ok, reason });
  }

  private async handleListShips(client: Client) {
    const session = this.playerSessions.get(client.sessionId);
    if (!session) return;

    try {
      const ships = await getShipsByPlayer(session.playerId);
      client.send("dock:ships", {
        ships: ships.map((s) => ({
          id: s.id,
          classKey: s.class,
          hull: s.hull,
          isActive: s.is_active,
        })),
      });
    } catch (err) {
      console.error("[OceanRoom] failed to list ships", err);
    }
  }

  private async handleBuyShip(client: Client, message: { classKey?: string }) {
    const docked = this.getDockedPlayerShip(client);
    if (!docked) return this.sendDockResult(client, "buyShip", false, "not docked");

    const classKey = message?.classKey ?? "";
    if (!isPurchasableShipClass(classKey)) {
      return this.sendDockResult(client, "buyShip", false, "unknown ship class");
    }

    const result = await buyShip(docked.session.playerId, classKey, docked.ship.honor);
    if (!result.ok) return this.sendDockResult(client, "buyShip", false, result.reason);

    docked.ship.gold = result.gold!;
    this.sendDockResult(client, "buyShip", true);
  }

  private async handleSwitchShip(client: Client, message: { shipId?: string }) {
    const docked = this.getDockedPlayerShip(client);
    if (!docked || !message?.shipId) {
      return this.sendDockResult(client, "switchShip", false, "not docked");
    }

    const result = await switchActiveShip(docked.session.playerId, message.shipId);
    if (!result.ok || !result.ship) {
      return this.sendDockResult(client, "switchShip", false, result.reason);
    }

    const newShip = result.ship;
    const stats = computeShipStats(newShip.class, newShip.upgrades);
    this.applyShipStats(docked.ship, newShip.class, newShip.upgrades, stats);
    docked.ship.hull = Math.min(newShip.hull, stats.maxHull);
    docked.ship.ammo = Math.min(newShip.ammo, stats.maxAmmo);
    this.applyCargoMirror(docked.ship, newShip.cargo);
    docked.ship.portReloadRemaining = 0;
    docked.ship.starboardReloadRemaining = 0;
    docked.session.shipId = newShip.id;

    this.sendDockResult(client, "switchShip", true);
  }

  private async handleRepair(client: Client) {
    const docked = this.getDockedPlayerShip(client);
    if (!docked) return this.sendDockResult(client, "repair", false, "not docked");

    const shipRow = this.toShipRow(docked.ship, docked.session);
    const result = await repairShip(docked.session.playerId, shipRow, docked.ship.honor);
    if (!result.ok || !result.ship) return this.sendDockResult(client, "repair", false, result.reason);

    docked.ship.gold = result.gold!;
    docked.ship.hull = result.ship.hull;
    this.sendDockResult(client, "repair", true);
  }

  private async handleBuyAmmo(client: Client) {
    const docked = this.getDockedPlayerShip(client);
    if (!docked) return this.sendDockResult(client, "buyAmmo", false, "not docked");

    const shipRow = this.toShipRow(docked.ship, docked.session);
    const result = await buyAmmo(docked.session.playerId, shipRow, docked.ship.honor);
    if (!result.ok || !result.ship) return this.sendDockResult(client, "buyAmmo", false, result.reason);

    docked.ship.gold = result.gold!;
    docked.ship.ammo = result.ship.ammo;
    this.sendDockResult(client, "buyAmmo", true);
  }

  private async handleBuyUpgrade(client: Client, message: { key?: string }) {
    const docked = this.getDockedPlayerShip(client);
    const key = message?.key as UpgradeKey | undefined;
    if (!docked || !key || !(key in UPGRADE_DEFS)) {
      return this.sendDockResult(client, "buyUpgrade", false, "not docked");
    }

    const shipRow = this.toShipRow(docked.ship, docked.session);
    const result = await buyUpgrade(docked.session.playerId, shipRow, key, docked.ship.honor);
    if (!result.ok || !result.ship) {
      return this.sendDockResult(client, "buyUpgrade", false, result.reason);
    }

    const stats = computeShipStats(docked.ship.shipClass as ShipClassKey, result.ship.upgrades);
    this.applyShipStats(docked.ship, docked.ship.shipClass as ShipClassKey, result.ship.upgrades, stats);
    docked.ship.gold = result.gold!;
    docked.ship.hull = result.ship.hull;

    this.sendDockResult(client, "buyUpgrade", true);
  }

  // ---------------------------------------------------------------------
  // Phase 7 (second slice): the Mercado tab's real commodity trading.
  // Prices are per-region (shared by every channel room of that region —
  // dock_prices is keyed by regionId, not by this room instance), so this
  // always reads straight from Postgres rather than caching anything here.
  // ---------------------------------------------------------------------

  private async handleListPrices(client: Client) {
    const docked = this.getDockedPlayerShip(client);
    if (!docked) return;

    try {
      const prices = await listDockPrices(this.regionId);
      client.send("dock:prices", { regionId: this.regionId, prices });
    } catch (err) {
      console.error("[OceanRoom] failed to list dock prices", err);
    }
  }

  private parseCommodityOrder(message: { commodity?: string; quantity?: number }): {
    commodity: CommodityKey;
    quantity: number;
  } | null {
    const commodity = message?.commodity as CommodityKey | undefined;
    const quantity = Math.floor(Number(message?.quantity));
    if (!commodity || !(COMMODITY_KEYS as string[]).includes(commodity)) return null;
    if (!Number.isFinite(quantity) || quantity <= 0) return null;
    return { commodity, quantity };
  }

  private async handleBuyCargo(client: Client, message: { commodity?: string; quantity?: number }) {
    const docked = this.getDockedPlayerShip(client);
    const order = this.parseCommodityOrder(message);
    if (!docked || !order) return this.sendDockResult(client, "buyCargo", false, "invalid order");

    const shipRow = this.toShipRow(docked.ship, docked.session);
    const result = await buyCommodity(
      docked.session.playerId,
      shipRow,
      this.regionId,
      order.commodity,
      order.quantity,
      docked.ship.honor
    );
    if (!result.ok || !result.cargo) return this.sendDockResult(client, "buyCargo", false, result.reason);

    docked.ship.gold = result.gold!;
    this.applyCargoMirror(docked.ship, result.cargo);
    this.sendDockResult(client, "buyCargo", true);
    await this.handleListPrices(client);
  }

  private async handleSellCargo(client: Client, message: { commodity?: string; quantity?: number }) {
    const docked = this.getDockedPlayerShip(client);
    const order = this.parseCommodityOrder(message);
    if (!docked || !order) return this.sendDockResult(client, "sellCargo", false, "invalid order");

    const shipRow = this.toShipRow(docked.ship, docked.session);
    const result = await sellCommodity(
      docked.session.playerId,
      shipRow,
      this.regionId,
      order.commodity,
      order.quantity,
      docked.ship.honor
    );
    if (!result.ok || !result.cargo) return this.sendDockResult(client, "sellCargo", false, result.reason);

    docked.ship.gold = result.gold!;
    this.applyCargoMirror(docked.ship, result.cargo);
    this.sendDockResult(client, "sellCargo", true);
    await this.handleListPrices(client);
  }

  // ---------------------------------------------------------------------
  // Phase 7 (fifth/final slice): the Mercado tab's player-to-player
  // listings sub-section — a genuinely separate system from the NPC
  // dock-price trading just above (different table, different tab
  // sub-section, see client/src/scenes/OceanScene.ts's renderMarketTab).
  // Gated on being docked, same as every other dock/market action.
  // ---------------------------------------------------------------------

  private async handleListMarketListings(client: Client) {
    const docked = this.getDockedPlayerShip(client);
    if (!docked) return;

    try {
      const listings = await listActiveListings(this.regionId);
      client.send("market:listings", { regionId: this.regionId, listings });
    } catch (err) {
      console.error("[OceanRoom] failed to list market listings", err);
    }
  }

  private async handleCreateListing(
    client: Client,
    message: { commodity?: string; quantity?: number; pricePerUnit?: number }
  ) {
    const docked = this.getDockedPlayerShip(client);
    const order = this.parseCommodityOrder(message);
    const pricePerUnit = Math.floor(Number(message?.pricePerUnit));
    if (!docked || !order || !Number.isFinite(pricePerUnit) || pricePerUnit <= 0) {
      return this.sendDockResult(client, "createListing", false, "invalid listing");
    }

    const shipRow = this.toShipRow(docked.ship, docked.session);
    const result = await createListing(
      docked.session.playerId,
      shipRow,
      this.regionId,
      order.commodity,
      order.quantity,
      pricePerUnit
    );
    if (!result.ok || !result.cargo) return this.sendDockResult(client, "createListing", false, result.reason);

    this.applyCargoMirror(docked.ship, result.cargo);
    this.sendDockResult(client, "createListing", true);
    await this.handleListMarketListings(client);
  }

  private async handleCancelListing(client: Client, message: { listingId?: string }) {
    const docked = this.getDockedPlayerShip(client);
    if (!docked || !message?.listingId) {
      return this.sendDockResult(client, "cancelListing", false, "invalid listing");
    }

    const shipRow = this.toShipRow(docked.ship, docked.session);
    const result = await cancelListing(docked.session.playerId, shipRow, message.listingId);
    if (!result.ok || !result.cargo) return this.sendDockResult(client, "cancelListing", false, result.reason);

    this.applyCargoMirror(docked.ship, result.cargo);
    this.sendDockResult(client, "cancelListing", true);
    await this.handleListMarketListings(client);
  }

  private async handleBuyListing(client: Client, message: { listingId?: string; quantity?: number }) {
    const docked = this.getDockedPlayerShip(client);
    const quantity = Math.floor(Number(message?.quantity));
    if (!docked || !message?.listingId || !Number.isFinite(quantity) || quantity <= 0) {
      return this.sendDockResult(client, "buyListing", false, "invalid order");
    }

    const shipRow = this.toShipRow(docked.ship, docked.session);
    const result = await buyListing(docked.session.playerId, shipRow, this.regionId, message.listingId, quantity);
    if (!result.ok || !result.cargo) return this.sendDockResult(client, "buyListing", false, result.reason);

    docked.ship.gold = result.gold!;
    this.applyCargoMirror(docked.ship, result.cargo);
    this.sendDockResult(client, "buyListing", true);
    await this.handleListMarketListings(client);
  }

  // ---------------------------------------------------------------------
  // Phase 7 (fifth/final slice): cosmetics shop (its own "Apariencia" dock
  // tab). Purely visual — buyCosmetic never touches hull/ammo/upgrades/
  // stats, just a players.cosmetic_* column and the matching schema
  // mirror field below.
  // ---------------------------------------------------------------------

  private async handleBuyCosmetic(client: Client, message: { slot?: string; key?: string }) {
    const docked = this.getDockedPlayerShip(client);
    const slot = message?.slot as CosmeticSlot | undefined;
    const key = message?.key;
    if (!docked || !slot || !key) {
      return this.sendDockResult(client, "buyCosmetic", false, "not docked");
    }

    const result = await buyCosmetic(docked.session.playerId, slot, key);
    if (!result.ok) return this.sendDockResult(client, "buyCosmetic", false, result.reason);

    docked.ship.gold = result.gold!;
    if (slot === "hullColor") docked.ship.cosmeticHullColor = key;
    else if (slot === "sailPattern") docked.ship.cosmeticSailPattern = key;
    else if (slot === "flagColor") docked.ship.cosmeticFlagColor = key;
    else if (slot === "wakeColor") docked.ship.cosmeticWakeColor = key;

    this.sendDockResult(client, "buyCosmetic", true);
  }

  private handleFire(client: Client, side: CannonSide) {
    const ship = this.state.ships.get(client.sessionId);
    if (!ship) return;
    this.tryFire(client.sessionId, ship, side);
  }

  // Shared by player fire messages and bot AI firing decisions, so both
  // paths get the same reload, ammo and safe-zone rules for free.
  private tryFire(ownerId: string, ship: ShipSchema, side: CannonSide): boolean {
    if (ship.sunk) return false;
    if (isInSafeZone(ship.x, ship.y)) return false;

    const remaining = side === "port" ? ship.portReloadRemaining : ship.starboardReloadRemaining;
    if (remaining > 0) return false;

    // Only players draw from a finite ammo stock; bots keep firing on
    // cooldown alone, matching their unchanged Phase 1-3 behavior.
    if (ship.kind === "player" && ship.ammo < ship.cannonsPerSide) return false;

    this.fireBroadside(ownerId, ship, side);
    if (ship.kind === "player") {
      ship.ammo -= ship.cannonsPerSide;

      const session = this.playerSessions.get(ownerId);
      if (session) {
        recordPlayerEvent(session.playerId, { kind: "cannon_fired" }).catch((err) => {
          console.error("[OceanRoom] failed to record cannon_fired event", err);
        });
      }
    }
    if (side === "port") ship.portReloadRemaining = ship.reloadSeconds;
    else ship.starboardReloadRemaining = ship.reloadSeconds;
    return true;
  }

  private fireBroadside(ownerId: string, ship: ShipSchema, side: CannonSide) {
    const origin = getCannonFiringOrigin(ship, side);
    const forwardX = Math.cos(ship.heading);
    const forwardY = Math.sin(ship.heading);

    for (let i = 0; i < ship.cannonsPerSide; i++) {
      const offset = (i - (ship.cannonsPerSide - 1) / 2) * CANNON_SPACING;
      const ball = new CannonballSchema();
      ball.x = origin.x + forwardX * offset;
      ball.y = origin.y + forwardY * offset;
      ball.vx = origin.dirX * CANNONBALL_SPEED;
      ball.vy = origin.dirY * CANNONBALL_SPEED;
      ball.ownerId = ownerId;
      ball.damage = ship.cannonDamage;

      const id = `ball-${this.cannonballCount++}`;
      this.state.cannonballs.set(id, ball);
      this.cannonballAge.set(id, 0);
    }
  }

  private tick() {
    this.tickWeekendEvent();
    this.tickBotAI();
    this.tickShipMovement();
    this.tickCannonballs();
    this.tickLootPickups();
    this.tickRespawns();
    this.tickBotSpawning();
    this.tickBossSpawning();
    this.tickMissionProgress();
    this.tickAutosave();
  }

  // Phase 7 (fourth slice): recomputed every tick (cheap — a couple of
  // Date field reads) rather than cached, so the window flipping mid-
  // session (an actual UTC day rollover, or FORCE_WEEKEND_EVENT toggling
  // between server restarts) is picked up without any extra plumbing.
  private tickWeekendEvent() {
    this.state.weekendEventActive = isWeekendEventActive();
  }

  // Phase 5: Escolta/Exploración can't be driven by recordPlayerEvent
  // alone (there's no discrete "event" for "still alive" or "still
  // sailing") so they get a per-tick spatial/survival check against the
  // small in-memory cache populated on join/accept. Caza needs no entry
  // here — bumpCazaMissionProgress (inside recordPlayerEvent) handles it
  // entirely off the bot_sunk event.
  private tickMissionProgress() {
    for (const [sessionId, session] of this.playerSessions) {
      const ship = this.state.ships.get(sessionId);
      if (!ship || ship.sunk) continue;

      const cache = this.activeMissionCache.get(sessionId);
      if (!cache) continue;

      if (cache.exploracion) {
        const params = cache.exploracion.params as ExploracionParams;
        const distance = Math.hypot(ship.x - params.x, ship.y - params.y);
        if (distance <= params.radius) {
          this.completeTrackedMission(sessionId, session.playerId, "exploracion");
        }
      }

      if (cache.escolta) {
        const params = cache.escolta.params as EscoltaParams;
        const escortShip = this.state.ships.get(params.escortBotId);

        if (!escortShip || escortShip.sunk) {
          this.failTrackedMission(sessionId, session.playerId, "escolta");
        } else {
          const mission = cache.escolta;
          const wholeSecondsBefore = Math.floor(mission.progress);
          mission.progress = Math.min(mission.target, mission.progress + DT_SECONDS);

          if (mission.progress >= mission.target) {
            this.completeTrackedMission(sessionId, session.playerId, "escolta");
          } else if (Math.floor(mission.progress) !== wholeSecondsBefore) {
            // Persist roughly once per second of survival rather than
            // 20x/sec — exact-tick precision isn't needed, this just
            // keeps a reopened Tavern tab showing fresh progress.
            updateMissionProgress(mission.id, mission.progress).catch((err) => {
              console.error("[OceanRoom] failed to persist escort mission progress", err);
            });
          }
        }
      }
    }
  }

  private completeTrackedMission(sessionId: string, playerId: string, type: "escolta" | "exploracion") {
    const cache = this.activeMissionCache.get(sessionId);
    const mission = cache?.[type];
    if (!cache || !mission) return;
    cache[type] = undefined;

    completeMission(playerId, mission.id)
      .then(() => this.syncShipFromPlayer(sessionId, playerId))
      .catch((err) => console.error(`[OceanRoom] failed to complete ${type} mission`, err));
  }

  private failTrackedMission(sessionId: string, playerId: string, type: "escolta" | "exploracion") {
    const cache = this.activeMissionCache.get(sessionId);
    const mission = cache?.[type];
    if (!cache || !mission) return;
    cache[type] = undefined;

    failMission(playerId, mission.id).catch((err) => {
      console.error(`[OceanRoom] failed to fail ${type} mission`, err);
    });
  }

  private tickShipMovement() {
    const now = Date.now();

    this.state.ships.forEach((ship, id) => {
      if (ship.sunk) return;

      const frozenUntil = this.transferringUntil.get(id);
      if (frozenUntil !== undefined) {
        if (now < frozenUntil) return; // mid-transfer: held in place while the seat reservation is in flight
        this.transferringUntil.delete(id); // safety timeout elapsed: thaw and fall through to normal movement
      }

      const input = this.lastInputs.get(id) ?? { throttle: 0, turn: 0 };
      const next = stepShip(
        { x: ship.x, y: ship.y, heading: ship.heading, speed: ship.speed },
        input,
        DT_SECONDS,
        {
          maxSpeed: ship.maxSpeed,
          acceleration: ACCELERATION,
          drag: DRAG,
          turnRate: ship.turnRate,
          turnAcceleration: TURN_ACCELERATION,
          reverseSpeedFactor: REVERSE_SPEED_FACTOR,
        }
      );

      // Phase 7 (first slice): only real players border-cross — bots stay
      // within their home region and keep clamping exactly as before.
      if (ship.kind === "player") {
        const crossing = detectBorderCrossing(this.region, next.x, next.y);
        if (crossing) {
          this.beginRegionTransfer(id, ship, next, crossing);
          return;
        }
      }

      const bounded = clampToWorldBounds(next.x, next.y);
      const resolved = resolveIslandCollisions(bounded.x, bounded.y, this.shipHitRadius(ship), this.region.islands);

      ship.x = resolved.x;
      ship.y = resolved.y;
      ship.heading = next.heading;
      ship.speed = next.speed;

      if (ship.portReloadRemaining > 0) {
        ship.portReloadRemaining = Math.max(0, ship.portReloadRemaining - DT_SECONDS);
      }
      if (ship.starboardReloadRemaining > 0) {
        ship.starboardReloadRemaining = Math.max(0, ship.starboardReloadRemaining - DT_SECONDS);
      }

      this.applyRockDamage(id, ship);
      this.trackSafeZoneTransition(id, ship);
    });
  }

  // Reserves a seat in the neighboring region's room (creating/joining its
  // current lowest-numbered under-cap channel via Colyseus's own
  // filterBy(["regionId"]) + maxClients matchmaking — see server/src/index.ts)
  // and hands the reservation to the client over "region:transfer". The
  // client calls colyseus.js's consumeSeatReservation() with it, which
  // connects straight to that room by id/sessionId — no fresh HTTP
  // matchmake or re-login round-trip, just a second WebSocket handshake.
  // The ship stays frozen here (see tickShipMovement) until that completes.
  private beginRegionTransfer(
    sessionId: string,
    ship: ShipSchema,
    next: { x: number; y: number; heading: number; speed: number },
    crossing: BorderCrossing
  ) {
    const session = this.playerSessions.get(sessionId);
    const client = this.findClient(sessionId);
    if (!session || !client) return;
    if (this.transferringUntil.has(sessionId)) return; // already in flight

    this.transferringUntil.set(sessionId, Date.now() + TRANSFER_FREEZE_TIMEOUT_MS);
    ship.heading = next.heading;
    ship.speed = next.speed;

    const payload: RegionTransferPayload = {
      shipId: session.shipId,
      x: crossing.entryX,
      y: crossing.entryY,
      heading: next.heading,
      speed: next.speed,
      hull: ship.hull,
      ammo: ship.ammo,
      gold: ship.gold,
    };

    matchMaker
      .joinOrCreate("ocean", { token: session.token, regionId: crossing.neighborRegionId, transfer: payload })
      .then((reservation) => {
        // The player may have fully disconnected while the reservation was
        // in flight — don't hand a dead session a seat reservation.
        if (!this.state.ships.has(sessionId)) return;
        client.send("region:transfer", reservation);
      })
      .catch((err) => {
        console.error("[OceanRoom] failed to reserve a seat in the neighboring region", err);
        this.transferringUntil.delete(sessionId);
      });
  }

  // Persists hull on the dock/safe-zone-entry transition, per the plan;
  // this also naturally covers a respawn (which teleports into the safe
  // zone) without any special-cased code.
  private trackSafeZoneTransition(sessionId: string, ship: ShipSchema) {
    const session = this.playerSessions.get(sessionId);
    if (!session) return;

    const inSafeZoneNow = isInSafeZone(ship.x, ship.y);
    if (inSafeZoneNow && !session.wasInSafeZone) {
      this.persistHull(session.shipId, ship.hull);
    }
    session.wasInSafeZone = inSafeZoneNow;
  }

  private tickAutosave() {
    this.autosaveAccumulator += DT_SECONDS;
    if (this.autosaveAccumulator < AUTOSAVE_INTERVAL_SECONDS) return;
    this.autosaveAccumulator = 0;

    // Gold needs no batched save here: every gold-affecting action already
    // writes through to Postgres immediately (see creditGold / db/dock.ts).
    this.playerSessions.forEach((session, sessionId) => {
      const ship = this.state.ships.get(sessionId);
      if (ship) this.persistHull(session.shipId, ship.hull);
    });
  }

  private persistHull(shipId: string, hull: number) {
    persistShipHull(shipId, hull).catch((err) => {
      console.error("[OceanRoom] failed to persist hull", err);
    });
  }

  private applyRockDamage(id: string, ship: ShipSchema) {
    if (ship.sunk) return;
    const rock = findTouchingRock(ship.x, ship.y, this.shipHitRadius(ship), this.region.rocks);
    if (!rock) return;

    ship.hull = Math.max(0, ship.hull - ROCK_DAMAGE_PER_SECOND * DT_SECONDS);
    if (ship.hull <= 0) this.sinkShip(id, ship);
  }

  private tickCannonballs() {
    const toRemove: { id: string; splashAt?: { x: number; y: number } }[] = [];

    this.state.cannonballs.forEach((ball, id) => {
      const next = stepCannonball({ x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy }, DT_SECONDS);
      ball.x = next.x;
      ball.y = next.y;

      const age = (this.cannonballAge.get(id) ?? 0) + DT_SECONDS;
      this.cannonballAge.set(id, age);

      if (age >= CANNONBALL_LIFETIME_SECONDS) {
        toRemove.push({ id, splashAt: { x: ball.x, y: ball.y } });
        return;
      }

      const targetId = this.findCannonballTarget(ball);
      if (targetId) {
        this.applyHit(targetId, ball);
        toRemove.push({ id });
      }
    });

    for (const entry of toRemove) {
      this.state.cannonballs.delete(entry.id);
      this.cannonballAge.delete(entry.id);
      if (entry.splashAt) {
        this.broadcast("splash", entry.splashAt);
      }
    }
  }

  private findCannonballTarget(ball: CannonballSchema): string | null {
    let found: string | null = null;
    const shooterShip = this.state.ships.get(ball.ownerId);

    this.state.ships.forEach((ship, sessionId) => {
      if (found || ship.sunk || sessionId === ball.ownerId) return;
      // Cannonballs simply pass through ships inside the safe zone: neither
      // the shooter nor the target can deal or take damage there.
      if (isInSafeZone(ship.x, ship.y)) return;

      // Phase 6: two more pass-through gates, both scoped to real PvP (bot
      // combat and rock damage are untouched) and following the exact same
      // shape as the safe-zone check above.
      if (ship.kind === "player" && shooterShip?.kind === "player") {
        // Novice protection: an account under 3h old can neither deal nor
        // receive PvP damage. Level-based protection is deferred — there's
        // no working leveling system yet (see shared/src/reputation.ts).
        if (isNoviceProtected(ship.createdAtMs) || isNoviceProtected(shooterShip.createdAtMs)) return;

        // No friendly fire between current group members (group membership
        // is playerId-keyed, see server/src/world/groups.ts).
        const shooterGroupId = groupsStore.getGroupIdForPlayer(this.playerSessions.get(ball.ownerId)?.playerId);
        const targetGroupId = groupsStore.getGroupIdForPlayer(this.playerSessions.get(sessionId)?.playerId);
        if (shooterGroupId && shooterGroupId === targetGroupId) return;
      }

      const distance = Math.hypot(ship.x - ball.x, ship.y - ball.y);
      if (distance <= this.shipHitRadius(ship)) {
        found = sessionId;
      }
    });

    return found;
  }

  private applyHit(targetId: string, ball: CannonballSchema) {
    const ship = this.state.ships.get(targetId);
    if (!ship) return;

    const shooterShip = this.state.ships.get(ball.ownerId);
    ship.hull = Math.max(0, ship.hull - ball.damage);

    if (ship.kind !== "player") {
      const contributions = this.botDamageContributions.get(targetId) ?? new Map<string, number>();
      contributions.set(ball.ownerId, (contributions.get(ball.ownerId) ?? 0) + ball.damage);
      this.botDamageContributions.set(targetId, contributions);
    } else if (shooterShip?.kind === "player") {
      this.maybeFlagPirate(ball.ownerId, shooterShip, ship);
    }

    this.broadcast("hit", {
      targetId,
      shooterId: ball.ownerId,
      x: ball.x,
      y: ball.y,
      damage: ball.damage,
      hull: ship.hull,
    });

    if (ship.hull <= 0) {
      const killerId = ball.ownerId;
      this.sinkShip(targetId, ship);
      if (ship.kind === "player") this.creditPlayerSunkEvent(killerId, targetId, ship);
    }
  }

  private sinkShip(id: string, ship: ShipSchema) {
    ship.sunk = true;
    this.broadcast("sunk", { sessionId: id, x: ship.x, y: ship.y });
    this.spawnLoot(ship.x, ship.y);

    if (ship.kind === "player") {
      this.handleCargoLossOnSink(id, ship);
    } else if (ship.kind === "boss") {
      this.rewardBossKill(id, ship);
      // Starts counting down immediately; tickBossSpawning only respawns
      // once this reaches 0 AND the weekend event is still active — it
      // deliberately never respawns once the window has ended.
      this.bossRespawnCooldownRemaining = BOSS_RESPAWN_COOLDOWN_SECONDS;
    } else {
      this.rewardBotKill(id, ship);
    }

    // Reused for both outcomes: a player respawns at the dock, a bot (or
    // boss) is removed entirely, once this delay elapses (see tickRespawns).
    this.respawnRemaining.set(id, RESPAWN_DELAY_SECONDS);
  }

  // Phase 7 (second slice) economy control: per the plan's "pérdida de
  // carga al hundirse", a sunk ship loses whatever cargo it was carrying.
  // Rather than just deleting it, each non-empty commodity becomes one
  // scavengable floating loot piece near the wreck — reusing the exact
  // Phase 2/3 loot pickup mechanic (spawnLoot/tickLootPickups) instead of
  // inventing a second drop system.
  private handleCargoLossOnSink(sessionId: string, ship: ShipSchema) {
    const cargo = this.cargoFromShip(ship);
    const session = this.playerSessions.get(sessionId);

    this.applyCargoMirror(ship, {});
    if (session) {
      clearShipCargo(session.shipId).catch((err) => {
        console.error("[OceanRoom] failed to clear cargo on sink", err);
      });
    }

    for (const commodity of COMMODITY_KEYS) {
      const qty = cargo[commodity] ?? 0;
      if (qty > 0) this.spawnCargoLoot(ship.x, ship.y, commodity, qty);
    }
  }

  private spawnCargoLoot(x: number, y: number, commodity: CommodityKey, qty: number) {
    const loot = new LootSchema();
    loot.x = x + (Math.random() - 0.5) * LOOT_SPAWN_SPREAD;
    loot.y = y + (Math.random() - 0.5) * LOOT_SPAWN_SPREAD;
    loot.commodity = commodity;
    loot.qty = qty;
    this.state.loot.set(`loot-${this.lootCount++}`, loot);
  }

  // Phase 6: the FIRST unprovoked hit a player lands on a currently-unflagged
  // target (outside the safe zone — guaranteed by findCannonballTarget)
  // marks the attacker as a pirate for PIRATE_FLAG_DURATION_SECONDS.
  // Deliberately NOT re-extended by further hits: if the attacker is
  // already flagged, or the target is already flagged (this isn't really
  // "unprovoked" — the target is the aggressor pattern, not an innocent),
  // nothing changes. This is a hit-level check (runs on every landed shot),
  // not a kill-level one.
  private maybeFlagPirate(shooterId: string, shooterShip: ShipSchema, targetShip: ShipSchema) {
    const shooterSession = this.playerSessions.get(shooterId);
    if (!shooterSession) return;
    if (isPirateFlagged(shooterShip.pirateFlagUntilMs)) return;
    if (isPirateFlagged(targetShip.pirateFlagUntilMs)) return;

    const until = Date.now() + PIRATE_FLAG_DURATION_SECONDS * 1000;
    setPirateFlagIfUnflagged(shooterSession.playerId, new Date(until))
      .then((applied) => {
        if (applied) shooterShip.pirateFlagUntilMs = until;
      })
      .catch((err) => console.error("[OceanRoom] failed to set pirate flag", err));
  }

  // Credits whoever's cannonball landed the finishing blow with a
  // player_sunk event (lifetime achievement + weekly PvP-ranking stat), plus
  // Phase 6 honor/bounty: +honor for sinking a flagged pirate, -honor
  // (bigger magnitude) for sinking an unflagged/innocent player; a flagged
  // killer's bounty grows on every player kill; sinking a flagged pirate
  // pays out their current bounty and resets it to 0 (the flag itself is
  // left to expire naturally). findCannonballTarget already guarantees a
  // ship can never hit itself.
  private creditPlayerSunkEvent(killerId: string, targetId: string, targetShip: ShipSchema) {
    const killerShip = this.state.ships.get(killerId);
    const killerSession = this.playerSessions.get(killerId);
    if (!killerShip || killerShip.kind !== "player" || !killerSession) return;

    const targetWasFlaggedPirate = isPirateFlagged(targetShip.pirateFlagUntilMs);
    const targetBountyBefore = targetShip.bounty;
    const targetSession = this.playerSessions.get(targetId);
    const killerWasFlagged = isPirateFlagged(killerShip.pirateFlagUntilMs);

    recordPlayerEvent(killerSession.playerId, { kind: "player_sunk" })
      .then(async () => {
        if (targetWasFlaggedPirate) {
          await adjustHonor(killerSession.playerId, HONOR_GAIN_PIRATE_KILL);
          if (targetSession && targetBountyBefore > 0) {
            const paid = await payoutBounty(targetSession.playerId, killerSession.playerId);
            if (paid > 0) await recordPlayerEvent(killerSession.playerId, { kind: "gold_earned", amount: paid });
          }
        } else {
          await adjustHonor(killerSession.playerId, -HONOR_LOSS_INNOCENT_KILL);
        }

        if (killerWasFlagged) {
          await incrementBounty(killerSession.playerId, BOUNTY_GAIN_PER_KILL);
        }

        await this.syncShipFromPlayer(killerId, killerSession.playerId);
      })
      .catch((err) => console.error("[OceanRoom] failed to record player_sunk event", err));
  }

  // Phase 6: a damaging player's group pools its combined contribution
  // share, then splits it evenly among currently-connected group members
  // — not just whoever personally landed shots. A solo (groupless)
  // attacker keeps their own share entirely, exactly as before. Phase 7
  // (first slice): group membership is playerId-keyed and can now span
  // rooms, but a bot fight (and its damage contributions map) is always
  // local to this one room — "present" means present in *this* room,
  // found the same way findSessionIdForPlayer already does for clans.
  //
  // Phase 7 (fourth slice): extracted out of rewardBotKill so a boss kill
  // (rewardBossKill below) splits its much larger pool through the exact
  // same group-aware logic instead of a second copy of it.
  private computeDamagePayouts(contributions: Map<string, number>, pool: number): Map<string, number> {
    const totalDamage = [...contributions.values()].reduce((sum, d) => sum + d, 0);
    const payouts = new Map<string, number>();
    if (totalDamage <= 0) return payouts;

    const processedGroups = new Set<string>();

    for (const [attackerId, damage] of contributions) {
      const attackerPlayerId = this.playerSessions.get(attackerId)?.playerId;
      const groupId = groupsStore.getGroupIdForPlayer(attackerPlayerId);

      if (groupId) {
        if (processedGroups.has(groupId)) continue;
        processedGroups.add(groupId);

        const group = groupsStore.getGroup(groupId);
        if (!group) continue;

        let groupDamage = 0;
        const presentMembers: string[] = [];
        for (const memberPlayerId of group.memberIds) {
          const memberSessionId = this.findSessionIdForPlayer(memberPlayerId);
          if (!memberSessionId) continue;
          presentMembers.push(memberSessionId);
          groupDamage += contributions.get(memberSessionId) ?? 0;
        }
        if (presentMembers.length === 0) continue;

        const groupShare = Math.round((groupDamage / totalDamage) * pool);
        const perMember = Math.floor(groupShare / presentMembers.length);
        for (const memberId of presentMembers) {
          payouts.set(memberId, (payouts.get(memberId) ?? 0) + perMember);
        }
      } else {
        const share = Math.round((damage / totalDamage) * pool);
        payouts.set(attackerId, (payouts.get(attackerId) ?? 0) + share);
      }
    }

    return payouts;
  }

  private async rewardBotKill(botId: string, ship: ShipSchema) {
    const contributions = this.botDamageContributions.get(botId);
    this.botDamageContributions.delete(botId);
    if (!contributions || contributions.size === 0) return;

    const pool = ship.kind === "pirate" ? BOT_GOLD_REWARD_PIRATE : BOT_GOLD_REWARD_MERCHANT;
    const payouts = this.computeDamagePayouts(contributions, pool);

    for (const [attackerId, share] of payouts) {
      const attacker = this.state.ships.get(attackerId);
      const session = this.playerSessions.get(attackerId);
      // Only real players have a persistent, DB-backed gold balance.
      if (!attacker || attacker.kind !== "player" || !session) continue;

      try {
        if (share > 0) {
          const balance = await creditGold(session.playerId, share, "bot_kill");
          attacker.gold = balance;
          await recordPlayerEvent(session.playerId, { kind: "gold_earned", amount: share });
        }
        // Credited regardless of gold share so a tiny-contribution kill
        // still counts toward Caza missions / lifetime bot-kill stats.
        await recordPlayerEvent(session.playerId, { kind: "bot_sunk", botKind: ship.kind as BotKind });
        if (ship.kind === "pirate") await adjustHonor(session.playerId, HONOR_GAIN_PIRATE_KILL);
        await this.syncShipFromPlayer(attackerId, session.playerId);
      } catch (err) {
        console.error("[OceanRoom] failed to credit bot-kill gold", err);
      }
    }
  }

  // Phase 7 (fourth slice): defeating a weekend-event boss. Same
  // damage-proportional/group-aware split and creditGold path as a
  // regular bot kill (computeDamagePayouts above), just with the much
  // larger BOSS_GOLD_REWARD pool, a distinct "boss_kill" transaction type,
  // and its own boss_sunk event (bumps lifetime_bosses_sunk, which the
  // boss_slayer achievement in shared/src/achievements.ts is keyed off —
  // see checkAchievements in db/tavern.ts). No honor adjustment: the boss
  // isn't a pirate/merchant and honor is a PvP-flavored reputation stat,
  // not a general "you killed something" one.
  private async rewardBossKill(bossId: string, ship: ShipSchema) {
    const contributions = this.botDamageContributions.get(bossId);
    this.botDamageContributions.delete(bossId);
    if (!contributions || contributions.size === 0) return;

    const payouts = this.computeDamagePayouts(contributions, BOSS_GOLD_REWARD);

    for (const [attackerId, share] of payouts) {
      const attacker = this.state.ships.get(attackerId);
      const session = this.playerSessions.get(attackerId);
      if (!attacker || attacker.kind !== "player" || !session) continue;

      try {
        if (share > 0) {
          const balance = await creditGold(session.playerId, share, "boss_kill");
          attacker.gold = balance;
          await recordPlayerEvent(session.playerId, { kind: "gold_earned", amount: share });
        }
        await recordPlayerEvent(session.playerId, { kind: "boss_sunk" });
        await this.syncShipFromPlayer(attackerId, session.playerId);
      } catch (err) {
        console.error("[OceanRoom] failed to credit boss-kill gold", err);
      }
    }
  }

  // recordPlayerEvent (and the Phase 6 honor/bounty writes above) can
  // cascade into further gold grants that the ship schema's mirrored
  // fields don't know about yet — this reconciles every mirror against the
  // DB-authoritative row in one place.
  private async syncShipFromPlayer(sessionId: string, playerId: string) {
    try {
      const ship = this.state.ships.get(sessionId);
      if (!ship) return;
      const player = await findPlayerById(playerId);
      if (!player) return;

      ship.gold = player.gold;
      ship.honor = player.honor;
      ship.bounty = player.bounty;
      ship.pirateFlagUntilMs = player.pirate_flag_until ? player.pirate_flag_until.getTime() : 0;
    } catch (err) {
      console.error("[OceanRoom] failed to sync ship from player", err);
    }
  }

  private spawnLoot(x: number, y: number) {
    const count = 1 + Math.floor(Math.random() * 2); // 1-2 pieces near the wreck
    for (let i = 0; i < count; i++) {
      const loot = new LootSchema();
      loot.x = x + (Math.random() - 0.5) * LOOT_SPAWN_SPREAD;
      loot.y = y + (Math.random() - 0.5) * LOOT_SPAWN_SPREAD;
      this.state.loot.set(`loot-${this.lootCount++}`, loot);
    }
  }

  private tickLootPickups() {
    const collectedIds = new Set<string>();

    this.state.loot.forEach((loot, id) => {
      this.state.ships.forEach((ship, sessionId) => {
        if (collectedIds.has(id) || ship.sunk) return;

        const distance = Math.hypot(ship.x - loot.x, ship.y - loot.y);
        if (distance <= LOOT_PICKUP_RADIUS) {
          collectedIds.add(id);
          this.awardLoot(sessionId, ship, loot);
        }
      });
    });

    collectedIds.forEach((id) => this.state.loot.delete(id));
  }

  // Loot/kill rewards credit gold directly — there's no separate raw
  // "silver" counter to convert later. Phase 7 (second slice): a loot piece
  // carrying a commodity (see spawnCargoLoot) grants cargo instead; every
  // other loot piece keeps the exact Phase 2/3 flat-gold behavior.
  private awardLoot(sessionId: string, ship: ShipSchema, loot: LootSchema) {
    if (ship.kind !== "player") return;
    const session = this.playerSessions.get(sessionId);
    if (!session) return;

    if (loot.commodity) {
      this.awardCargoLoot(ship, session, loot.commodity as CommodityKey, loot.qty);
      return;
    }

    creditGold(session.playerId, 1, "loot_pickup")
      .then(async (balance) => {
        ship.gold = balance;
        await recordPlayerEvent(session.playerId, { kind: "gold_earned", amount: 1 });
        await this.syncShipFromPlayer(sessionId, session.playerId);
      })
      .catch((err) => console.error("[OceanRoom] failed to credit loot gold", err));
  }

  // Grants up to the ship's remaining hold space; anything beyond that is
  // simply lost rather than left behind as a residual loot piece — a
  // documented simplification, not sophisticated economic modeling.
  private awardCargoLoot(
    ship: ShipSchema,
    session: PlayerSessionInfo,
    commodity: CommodityKey,
    qty: number
  ) {
    const currentCargo = this.cargoFromShip(ship);
    const used = totalCargoQuantity(currentCargo);
    const granted = Math.max(0, Math.min(qty, ship.cargoCapacity - used));
    if (granted <= 0) return;

    grantShipCargo(session.shipId, commodity, granted, currentCargo)
      .then((cargo) => this.applyCargoMirror(ship, cargo))
      .catch((err) => console.error("[OceanRoom] failed to grant scavenged cargo", err));
  }

  private tickRespawns() {
    for (const [id, remaining] of this.respawnRemaining) {
      const next = remaining - DT_SECONDS;
      if (next > 0) {
        this.respawnRemaining.set(id, next);
        continue;
      }

      this.respawnRemaining.delete(id);
      const ship = this.state.ships.get(id);
      if (!ship) continue;

      if (ship.kind === "player") this.respawnShip(id);
      else this.removeBot(id);
    }
  }

  private respawnShip(sessionId: string) {
    const ship = this.state.ships.get(sessionId);
    const spawn = this.spawnPoints.get(sessionId);
    if (!ship || !spawn) return;

    ship.x = spawn.x;
    ship.y = spawn.y;
    ship.heading = 0;
    ship.speed = 0;
    ship.hull = ship.maxHull;
    ship.ammo = ship.maxAmmo;
    ship.sunk = false;
    ship.portReloadRemaining = 0;
    ship.starboardReloadRemaining = 0;
  }

  private removeBot(id: string) {
    this.state.ships.delete(id);
    this.lastInputs.delete(id);
    this.botRuntimes.delete(id);
    this.botDamageContributions.delete(id);
    this.bossVolleyTimers.delete(id);
  }

  private tickBotAI() {
    const players: PlayerCandidate[] = [];
    this.state.ships.forEach((ship, id) => {
      if (ship.kind === "player" && !ship.sunk) players.push({ sessionId: id, x: ship.x, y: ship.y });
    });

    this.state.ships.forEach((ship, id) => {
      if (ship.kind === "player" || ship.sunk) return;

      const runtime = this.botRuntimes.get(id);
      if (!runtime) return;

      const decision = decideBotAction(
        ship.aiState as BotAIState,
        runtime,
        { x: ship.x, y: ship.y, heading: ship.heading, hull: ship.hull, maxHull: ship.maxHull },
        players
      );

      this.lastInputs.set(id, decision.input);
      ship.aiState = decision.nextState;
      runtime.targetId = decision.targetId;
      if (decision.nextWaypoint) runtime.waypoint = decision.nextWaypoint;

      if (decision.fireSide) this.tryFire(id, ship, decision.fireSide);
      if (ship.kind === "boss") this.tickBossVolley(id, ship);
    });
  }

  // Phase 7 (fourth slice): the boss's special attack — a heavier
  // omnidirectional volley on its own cadence, independent of (and in
  // addition to) the normal per-side broadside/reload cycle every bot
  // already fires through tryFire above. Only unleashed while actively
  // engaging a target, same spirit as the normal "attack" AI state firing
  // broadsides only once in range.
  private tickBossVolley(id: string, ship: ShipSchema) {
    if (ship.aiState !== "attack") return;

    const remaining = (this.bossVolleyTimers.get(id) ?? BOSS_VOLLEY_INTERVAL_SECONDS) - DT_SECONDS;
    if (remaining > 0) {
      this.bossVolleyTimers.set(id, remaining);
      return;
    }

    this.fireBossVolley(id, ship);
    this.bossVolleyTimers.set(id, BOSS_VOLLEY_INTERVAL_SECONDS);
  }

  // Spreads BOSS_VOLLEY_BALL_COUNT cannonballs evenly around the full
  // circle (shared/src/physics.ts's getOmniVolleyDirections) instead of
  // fireBroadside's two fixed port/starboard sides — but reuses the exact
  // same CannonballSchema + CANNON_ORIGIN_OFFSET + CANNONBALL_SPEED +
  // cannonballAge/stepCannonball machinery as every normal shot, so
  // tickCannonballs handles these identically with no special-casing.
  private fireBossVolley(ownerId: string, ship: ShipSchema) {
    for (const dir of getOmniVolleyDirections(BOSS_VOLLEY_BALL_COUNT)) {
      const ball = new CannonballSchema();
      ball.x = ship.x + dir.dirX * CANNON_ORIGIN_OFFSET;
      ball.y = ship.y + dir.dirY * CANNON_ORIGIN_OFFSET;
      ball.vx = dir.dirX * CANNONBALL_SPEED;
      ball.vy = dir.dirY * CANNONBALL_SPEED;
      ball.ownerId = ownerId;
      ball.damage = BOSS_VOLLEY_DAMAGE;

      const id = `ball-${this.cannonballCount++}`;
      this.state.cannonballs.set(id, ball);
      this.cannonballAge.set(id, 0);
    }

    this.broadcast("bossVolley", { x: ship.x, y: ship.y });
  }

  private tickBotSpawning() {
    this.tickBotSpawningForKind("pirate");
    this.tickBotSpawningForKind("merchant");
  }

  // Phase 7 (fourth slice): at most 1 boss per room instance (the same
  // per-room granularity every other bot already spawns at — pirate/
  // merchant counts above are never deduplicated across a region's
  // channels either), gated on the weekend event rather than player count.
  private tickBossSpawning() {
    if (this.bossRespawnCooldownRemaining > 0) {
      this.bossRespawnCooldownRemaining = Math.max(0, this.bossRespawnCooldownRemaining - DT_SECONDS);
    }

    if (!isWeekendEventActive()) return;
    if (this.bossRespawnCooldownRemaining > 0) return;
    if (this.countBots("boss") > 0) return;

    this.spawnBot("boss");
  }

  private tickBotSpawningForKind(kind: BotKind) {
    const remaining = (this.botRespawnTimers.get(kind) ?? 0) - DT_SECONDS;
    if (remaining > 0) {
      this.botRespawnTimers.set(kind, remaining);
      return;
    }

    if (this.countBots(kind) < this.botTargetCount(kind)) {
      this.spawnBot(kind);
    }

    this.botRespawnTimers.set(kind, randomRange(BOT_RESPAWN_MIN_SECONDS, BOT_RESPAWN_MAX_SECONDS));
  }

  private botTargetCount(kind: BotKind): number {
    // Single-zone target count that scales with players present; a full
    // multi-room/grid-of-zones scheme is out of scope for this phase.
    const extraPlayers = Math.max(0, this.clients.length - 1);

    if (kind === "pirate") {
      return Math.min(
        BOT_TARGET_CAP_PER_KIND,
        BOT_TARGET_BASE_PIRATES + extraPlayers * BOT_TARGET_PER_PLAYER_PIRATES
      );
    }

    return Math.min(
      BOT_TARGET_CAP_PER_KIND,
      BOT_TARGET_BASE_MERCHANTS + extraPlayers * BOT_TARGET_PER_PLAYER_MERCHANTS
    );
  }

  private countBots(kind: BotKind): number {
    let count = 0;
    this.state.ships.forEach((ship) => {
      if (ship.kind === kind) count++;
    });
    return count;
  }

  private spawnBot(kind: BotKind) {
    const isBoss = kind === "boss";
    // Phase 7 (fourth slice): the boss spawns at the region's fixed
    // far-corner danger point (shared/src/world.ts's BOSS_SPAWN_POINT)
    // instead of a random clear spot — see that file's comment for why
    // one fixed point is correct for every region.
    const position = isBoss ? BOSS_SPAWN_POINT : this.findBotSpawnPosition();
    const shipClass: ShipClassKey = isBoss ? "boss" : BOT_SHIP_CLASS;
    const stats = computeShipStats(shipClass, {});

    const ship = new ShipSchema();
    ship.x = position.x;
    ship.y = position.y;
    ship.heading = Math.random() * Math.PI * 2;
    ship.speed = 0;
    ship.kind = kind;
    ship.aiState = "patrol";
    this.applyShipStats(ship, shipClass, {}, stats);
    ship.hull = stats.maxHull;
    ship.ammo = stats.maxAmmo;
    // computeShipStats's cannonDamage formula is class-independent (always
    // CANNON_DAMAGE + upgrades, see shared/src/upgrades.ts), so the boss's
    // much heavier hit needs an explicit override here, same spot every
    // other per-ship stat field above it is set.
    if (isBoss) ship.cannonDamage = BOSS_CANNON_DAMAGE;
    // The giant ship gets an obviously different name over its head too
    // (see client's renderNameAndClanLabels-adjacent boss label), reusing
    // the exact displayName mirror field real players use.
    if (isBoss) ship.displayName = "☠ JEFE DE LOS MARES ☠";

    const id = `${isBoss ? "boss" : "bot"}-${this.botSpawnCount++}`;
    this.state.ships.set(id, ship);
    this.lastInputs.set(id, { throttle: 0, turn: 0 });
    this.botRuntimes.set(id, {
      kind,
      homeX: position.x,
      homeY: position.y,
      waypoint: position,
      targetId: null,
    });
  }

  private findBotSpawnPosition(): { x: number; y: number } {
    for (let attempt = 0; attempt < BOT_SPAWN_ATTEMPTS; attempt++) {
      const x = Math.random() * WORLD_WIDTH;
      const y = Math.random() * WORLD_HEIGHT;

      // findBotSpawnPosition only ever spawns bot-default ships (the boss
      // uses the fixed BOSS_SPAWN_POINT instead — see spawnBot), so this
      // clearance margin uses bot-default's own real hitRadius rather than
      // a generic/boundary constant.
      const spawnClearance = SHIP_CLASSES["bot-default"].hitRadius * 2;
      if (isInSafeZone(x, y)) continue;
      if (this.region.rocks.some((rock) => Math.hypot(x - rock.x, y - rock.y) <= rock.radius + spawnClearance)) {
        continue;
      }
      if (
        this.region.islands.some(
          (island) => Math.hypot(x - island.x, y - island.y) <= island.radius + spawnClearance
        )
      ) {
        continue;
      }

      let tooCloseToPlayer = false;
      this.state.ships.forEach((ship) => {
        if (tooCloseToPlayer || ship.kind !== "player") return;
        if (Math.hypot(ship.x - x, ship.y - y) < BOT_SPAWN_MIN_PLAYER_DISTANCE) tooCloseToPlayer = true;
      });
      if (tooCloseToPlayer) continue;

      return { x, y };
    }

    // Fallback if every attempt collided with something: a far corner is
    // always outside the safe zone and sparsely populated.
    return { x: WORLD_WIDTH * 0.1, y: WORLD_HEIGHT * 0.1 };
  }

  // ---------------------------------------------------------------------
  // Phase 5: Tavern (mission board, daily tasks, login streak, weekly
  // challenges, achievements). Follows the same message/ack pattern as the
  // Phase 4 dock handlers above: a `tavernResult` ack plus a fresh
  // `tavern:state` push, rather than a new sync layer.
  // ---------------------------------------------------------------------

  private async initTavernSession(sessionId: string, playerId: string): Promise<void> {
    await updateLoginStreak(playerId, LOGIN_STREAK_CHEST_INTERVAL, LOGIN_STREAK_CHEST_GOLD);
    await ensureDailyTasks(playerId);
    await this.syncShipFromPlayer(sessionId, playerId);

    const missions = await getActiveMissions(playerId);
    const cache: ActiveMissionCache = {};
    for (const mission of missions) {
      if (mission.mission_type === "escolta") {
        cache.escolta = {
          id: mission.id,
          progress: mission.progress,
          target: mission.target,
          params: mission.params as EscoltaParams,
        };
      } else if (mission.mission_type === "exploracion") {
        cache.exploracion = {
          id: mission.id,
          progress: mission.progress,
          target: mission.target,
          params: mission.params as ExploracionParams,
        };
      }
    }
    this.activeMissionCache.set(sessionId, cache);
  }

  private sendTavernResult(client: Client, action: string, ok: boolean, reason?: string) {
    client.send("tavernResult", { action, ok, reason });
  }

  private async sendTavernState(client: Client, playerId: string, offers: MissionOffer[]) {
    try {
      const bundle = await getTavernBundle(playerId);
      client.send("tavern:state", { ...bundle, offers });
    } catch (err) {
      console.error("[OceanRoom] failed to refresh tavern state", err);
    }
  }

  private async handleTavernOpen(client: Client) {
    const session = this.playerSessions.get(client.sessionId);
    if (!session) return;

    const offers = this.generateMissionOffers();
    this.missionOffers.set(client.sessionId, offers);
    await this.sendTavernState(client, session.playerId, offers);
  }

  // Cheap periodic poll while the Tavern tab is open client-side (see
  // OceanScene): re-sends progress/streak/weekly/achievements without
  // touching the mission board, so offers don't churn under the player
  // while they're just looking at it. Deliberately not a push-based sync
  // layer — see the plan's note that fresh-on-reopen is an acceptable
  // simplification; this just makes "reopen" cheap enough to do every
  // few seconds too.
  private async handleTavernRefresh(client: Client) {
    const session = this.playerSessions.get(client.sessionId);
    if (!session) return;

    let offers = this.missionOffers.get(client.sessionId);
    if (!offers) {
      offers = this.generateMissionOffers();
      this.missionOffers.set(client.sessionId, offers);
    }
    await this.sendTavernState(client, session.playerId, offers);
  }

  // Up to 4 slots: Caza, Escolta (only if a merchant bot is currently
  // alive to protect), Exploración, Caza — regenerated wholesale on every
  // tavern:open, and slot-by-slot on accept (see handleAcceptMission).
  private generateMissionOffers(): MissionOffer[] {
    const offers: MissionOffer[] = [this.generateSingleOffer("caza")];

    const escolta = this.generateEscoltaOfferIfPossible();
    if (escolta) offers.push(escolta);

    offers.push(this.generateSingleOffer("exploracion"));
    offers.push(this.generateSingleOffer("caza"));
    return offers;
  }

  private generateSingleOffer(type: MissionType): MissionOffer {
    if (type === "escolta") {
      return this.generateEscoltaOfferIfPossible() ?? this.generateSingleOffer("caza");
    }
    if (type === "exploracion") {
      const landmark = this.region.islands[Math.floor(Math.random() * this.region.islands.length)];
      return generateExploracionOffer(Math.random, landmark);
    }

    const roll = Math.random();
    const botKind: BotKind | undefined = roll < 0.33 ? "pirate" : roll < 0.66 ? "merchant" : undefined;
    return generateCazaOffer(Math.random, botKind);
  }

  private generateEscoltaOfferIfPossible(): MissionOffer | null {
    const botId = this.findLiveMerchantBot();
    if (!botId) return null;
    return generateEscoltaOffer(Math.random, botId);
  }

  private findLiveMerchantBot(): string | null {
    let found: string | null = null;
    this.state.ships.forEach((ship, id) => {
      if (found || ship.kind !== "merchant" || ship.sunk) return;
      found = id;
    });
    return found;
  }

  private async handleAcceptMission(client: Client, message: { slot?: number }) {
    const session = this.playerSessions.get(client.sessionId);
    const offers = this.missionOffers.get(client.sessionId);
    const slot = message?.slot;

    if (!session || !offers || slot === undefined || !offers[slot]) {
      return this.sendTavernResult(client, "acceptMission", false, "invalid offer");
    }

    const offer = offers[slot];
    if (offer.type === "escolta") {
      const params = offer.params as EscoltaParams;
      const escortShip = this.state.ships.get(params.escortBotId);
      if (!escortShip || escortShip.sunk) {
        return this.sendTavernResult(client, "acceptMission", false, "escort target no longer available");
      }
    }

    const result = await createMission(session.playerId, offer);
    if (!result.ok || !result.data) {
      return this.sendTavernResult(client, "acceptMission", false, result.reason);
    }

    if (offer.type === "escolta" || offer.type === "exploracion") {
      const cache = this.activeMissionCache.get(client.sessionId) ?? {};
      cache[offer.type] = {
        id: result.data.id,
        progress: 0,
        target: offer.target,
        params: offer.params as EscoltaParams | ExploracionParams,
      };
      this.activeMissionCache.set(client.sessionId, cache);
    }

    // Regenerated so the board stays full of acceptable offers.
    offers[slot] = this.generateSingleOffer(offer.type);

    this.sendTavernResult(client, "acceptMission", true);
    await this.sendTavernState(client, session.playerId, offers);
  }

  private async handleClaimDailyTask(client: Client, message: { taskId?: string }) {
    const session = this.playerSessions.get(client.sessionId);
    if (!session || !message?.taskId) {
      return this.sendTavernResult(client, "claimDailyTask", false, "invalid task");
    }

    const result = await claimDailyTask(session.playerId, message.taskId);
    if (!result.ok) return this.sendTavernResult(client, "claimDailyTask", false, result.reason);

    await this.syncShipFromPlayer(client.sessionId, session.playerId);
    this.sendTavernResult(client, "claimDailyTask", true);
    await this.sendTavernState(client, session.playerId, this.missionOffers.get(client.sessionId) ?? []);
  }

  private async handleRerollDailyTask(client: Client, message: { taskId?: string }) {
    const session = this.playerSessions.get(client.sessionId);
    if (!session || !message?.taskId) {
      return this.sendTavernResult(client, "rerollDailyTask", false, "invalid task");
    }

    const result = await rerollDailyTask(session.playerId, message.taskId);
    if (!result.ok) return this.sendTavernResult(client, "rerollDailyTask", false, result.reason);

    this.sendTavernResult(client, "rerollDailyTask", true);
    await this.sendTavernState(client, session.playerId, this.missionOffers.get(client.sessionId) ?? []);
  }

  // ---------------------------------------------------------------------
  // Phase 6: chat (zone / global / group / clan channels, rate-limited and
  // profanity-filtered server-side; reporting only ever logs a
  // chat_reports row — there is no moderation UI yet, nothing is actioned
  // automatically). Phase 7 (first slice) splits zone from global now that
  // there's more than one room instance: zone stays scoped to the sender's
  // own region+channel room, global fans out to every room in the process
  // via the directory, group/clan resolve each member's current room
  // (possibly different from the sender's) the same way.
  // ---------------------------------------------------------------------

  private sendChatResult(client: Client, ok: boolean, reason?: string) {
    client.send("chatResult", { ok, reason });
  }

  // Sliding window: at most CHAT_RATE_LIMIT_MAX_MESSAGES sends per player
  // per CHAT_RATE_LIMIT_WINDOW_SECONDS. Enforced here regardless of
  // whatever throttling the client does — excess sends are dropped, not
  // just discouraged.
  private consumeChatRateLimit(sessionId: string): boolean {
    const now = Date.now();
    const windowStart = now - CHAT_RATE_LIMIT_WINDOW_SECONDS * 1000;
    const timestamps = (this.chatTimestamps.get(sessionId) ?? []).filter((t) => t > windowStart);

    if (timestamps.length >= CHAT_RATE_LIMIT_MAX_MESSAGES) {
      this.chatTimestamps.set(sessionId, timestamps);
      return false;
    }

    timestamps.push(now);
    this.chatTimestamps.set(sessionId, timestamps);
    return true;
  }

  private handleChatSend(client: Client, message: { channel?: ChatChannel; text?: string }) {
    const session = this.playerSessions.get(client.sessionId);
    if (!session) return;

    const channel: ChatChannel =
      message?.channel === "zone" || message?.channel === "group" || message?.channel === "clan"
        ? message.channel
        : "global";
    const rawText = typeof message?.text === "string" ? message.text.trim() : "";
    if (!rawText) return this.sendChatResult(client, false, "empty message");
    if (rawText.length > CHAT_MAX_MESSAGE_LENGTH) return this.sendChatResult(client, false, "message too long");

    if (channel === "group" && !groupsStore.getGroupIdForPlayer(session.playerId)) {
      return this.sendChatResult(client, false, "not in a group");
    }
    if (channel === "clan" && !this.sessionClanId.get(client.sessionId)) {
      return this.sendChatResult(client, false, "not in a clan");
    }

    if (!this.consumeChatRateLimit(client.sessionId)) {
      return this.sendChatResult(client, false, "rate limited");
    }

    const chatMessage: ChatMessage = {
      channel,
      senderId: session.playerId,
      senderName: this.displayNames.get(client.sessionId) ?? "?",
      text: filterProfanity(rawText),
      timestamp: Date.now(),
    };

    this.deliverChatMessage(client.sessionId, chatMessage);
    this.sendChatResult(client, true);
  }

  private deliverChatMessage(senderSessionId: string, msg: ChatMessage) {
    if (msg.channel === "zone") {
      // Scoped to this one region+channel room instance only.
      this.broadcast("chat:message", msg);
      return;
    }

    if (msg.channel === "global") {
      // Reaches every region+channel room currently instantiated in this
      // process — see server/src/world/directory.ts's room registry.
      for (const room of directory.allRooms()) room.broadcast("chat:message", msg);
      return;
    }

    if (msg.channel === "group") {
      // msg.senderId is the persistent playerId (set in handleChatSend),
      // matching groupsStore's playerId-keyed membership.
      const groupId = groupsStore.getGroupIdForPlayer(msg.senderId);
      if (!groupId) return;
      const group = groupsStore.getGroup(groupId);
      if (!group) return;
      for (const memberId of group.memberIds) this.deliverToPlayer(memberId, "chat:message", msg);
      return;
    }

    // clan: reaches every currently-connected clan member, wherever their
    // room/channel is. sessionClanId is a per-room cache (see
    // refreshClanState), so this checks it across every room instance
    // rather than assuming same-room delivery like before Phase 7.
    const clanId = this.sessionClanId.get(senderSessionId);
    if (!clanId) return;
    for (const room of directory.allRooms()) {
      for (const c of room.clients) {
        if (room.sessionClanId.get(c.sessionId) === clanId) c.send("chat:message", msg);
      }
    }
  }

  private async handleChatReport(client: Client, message: { reportedPlayerId?: string; text?: string }) {
    const session = this.playerSessions.get(client.sessionId);
    if (!session || !message?.reportedPlayerId || typeof message.text !== "string" || !message.text.trim()) {
      return this.sendChatResult(client, false, "invalid report");
    }

    try {
      await insertChatReport(session.playerId, message.reportedPlayerId, message.text.trim().slice(0, 500));
      this.sendChatResult(client, true);
    } catch (err) {
      console.error("[OceanRoom] failed to insert chat report", err);
      this.sendChatResult(client, false, "failed to report");
    }
  }

  // ---------------------------------------------------------------------
  // Phase 6: groups ("alianzas temporales") — in-memory only, capped at
  // MAX_GROUP_SIZE. No friendly fire (findCannonballTarget) and pooled
  // bot-kill reward splitting (rewardBotKill) both key off the same
  // playerId-based groupsStore module. Phase 7 (first slice): membership
  // moved there (process-wide, not per-room) specifically so it survives a
  // member border-crossing into a different region+channel room — see
  // server/src/world/groups.ts. Inviting someone is still only ever done
  // against a currently-visible nearby ship (same-room by construction),
  // so invite targeting itself stays session-based.
  // ---------------------------------------------------------------------

  private sendGroupResult(client: Client, action: string, ok: boolean, reason?: string) {
    client.send("groupResult", { action, ok, reason });
  }

  private findClient(sessionId: string): Client | undefined {
    return this.clients.find((c) => c.sessionId === sessionId);
  }

  // Resolves which room instance a player (by persistent playerId) is
  // currently connected to — this room, a different one, or none at all —
  // via the cross-room directory. The one building block every
  // cross-room delivery/lookup below is built on.
  private roomForPlayer(playerId: string): OceanRoom | null {
    const loc = directory.getPlayerLocation(playerId);
    if (!loc) return null;
    return directory.getRoom(loc.roomKey) ?? null;
  }

  // Delivers a message to a player wherever their current session/room is
  // (possibly a different region+channel room than this one). Returns
  // false if they're not currently connected anywhere.
  private deliverToPlayer(playerId: string, type: string, payload: unknown): boolean {
    const room = this.roomForPlayer(playerId);
    const sessionId = room?.findSessionIdForPlayer(playerId);
    const client = sessionId ? room!.findClient(sessionId) : undefined;
    if (!client) return false;
    client.send(type, payload);
    return true;
  }

  // Cross-room-safe display name lookup, same pattern as deliverToPlayer.
  private resolveDisplayName(playerId: string): string {
    const room = this.roomForPlayer(playerId);
    if (!room) return "?";
    const sessionId = room.findSessionIdForPlayer(playerId);
    return sessionId ? room.displayNames.get(sessionId) ?? "?" : "?";
  }

  private handleGroupInvite(client: Client, message: { targetSessionId?: string }) {
    const inviterSession = this.playerSessions.get(client.sessionId);
    const targetId = message?.targetSessionId;
    if (!inviterSession || !targetId || targetId === client.sessionId) {
      return this.sendGroupResult(client, "invite", false, "invalid target");
    }

    const targetShip = this.state.ships.get(targetId);
    const targetSession = this.playerSessions.get(targetId);
    if (!targetShip || targetShip.kind !== "player" || !targetSession) {
      return this.sendGroupResult(client, "invite", false, "player not found");
    }
    if (groupsStore.getGroupIdForPlayer(targetSession.playerId)) {
      return this.sendGroupResult(client, "invite", false, "target already in a group");
    }

    const existingGroupId = groupsStore.getGroupIdForPlayer(inviterSession.playerId);
    let group = existingGroupId ? groupsStore.getGroup(existingGroupId) : undefined;
    if (group && group.leaderId !== inviterSession.playerId) {
      return this.sendGroupResult(client, "invite", false, "only the group leader can invite");
    }

    if (!group) {
      // A groupless player's first invite implicitly forms a new
      // one-member group with themself as leader.
      group = groupsStore.createGroup(inviterSession.playerId);
    }

    if (group.memberIds.size >= MAX_GROUP_SIZE) return this.sendGroupResult(client, "invite", false, "group is full");

    this.pendingGroupInvites.set(targetId, {
      groupId: group.id,
      inviterId: client.sessionId,
      expiresAt: Date.now() + INVITE_EXPIRY_MS,
    });

    this.findClient(targetId)?.send("group:inviteReceived", {
      fromSessionId: client.sessionId,
      fromName: this.displayNames.get(client.sessionId) ?? "?",
      groupId: group.id,
    });
    this.sendGroupResult(client, "invite", true);
  }

  private handleGroupRespond(client: Client, message: { accept?: boolean }) {
    const targetId = client.sessionId;
    const invite = this.pendingGroupInvites.get(targetId);
    this.pendingGroupInvites.delete(targetId);

    if (!invite || invite.expiresAt < Date.now()) {
      return this.sendGroupResult(client, "respond", false, "invite expired");
    }
    if (!message?.accept) return this.sendGroupResult(client, "respond", true);

    const session = this.playerSessions.get(targetId);
    if (!session) return;
    if (groupsStore.getGroupIdForPlayer(session.playerId)) {
      return this.sendGroupResult(client, "respond", false, "already in a group");
    }

    const group = groupsStore.getGroup(invite.groupId);
    if (!group) return this.sendGroupResult(client, "respond", false, "group no longer exists");
    if (group.memberIds.size >= MAX_GROUP_SIZE) return this.sendGroupResult(client, "respond", false, "group is full");

    groupsStore.addMember(group.id, session.playerId);
    this.broadcastGroupState(group);
    this.sendGroupResult(client, "respond", true);
  }

  private handleGroupLeave(client: Client) {
    const session = this.playerSessions.get(client.sessionId);
    const had = !!session && !!groupsStore.getGroupIdForPlayer(session.playerId);
    if (session) this.removeFromGroup(session.playerId);
    this.sendGroupResult(client, "leave", had);
  }

  private handleGroupKick(client: Client, message: { targetPlayerId?: string }) {
    const session = this.playerSessions.get(client.sessionId);
    const groupId = session ? groupsStore.getGroupIdForPlayer(session.playerId) : undefined;
    const group = groupId ? groupsStore.getGroup(groupId) : undefined;
    if (!session || !group || group.leaderId !== session.playerId) {
      return this.sendGroupResult(client, "kick", false, "only the group leader can kick");
    }

    const targetPlayerId = message?.targetPlayerId;
    if (!targetPlayerId || targetPlayerId === session.playerId || !group.memberIds.has(targetPlayerId)) {
      return this.sendGroupResult(client, "kick", false, "invalid target");
    }

    groupsStore.removeMember(targetPlayerId);
    this.deliverToPlayer(targetPlayerId, "group:state", { groupId: null, leaderId: null, members: [] });
    this.broadcastGroupState(group);
    this.sendGroupResult(client, "kick", true);
  }

  private handleGroupDisband(client: Client) {
    const session = this.playerSessions.get(client.sessionId);
    const groupId = session ? groupsStore.getGroupIdForPlayer(session.playerId) : undefined;
    const group = groupId ? groupsStore.getGroup(groupId) : undefined;
    if (!session || !group || group.leaderId !== session.playerId) {
      return this.sendGroupResult(client, "disband", false, "only the group leader can disband");
    }

    this.removeFromGroup(session.playerId);
    this.sendGroupResult(client, "disband", true);
  }

  // Shared by explicit leave/disband and onLeave disconnect cleanup
  // (border-crossing transfers skip this entirely — see onLeave). A
  // leaving/disconnecting leader disbands the whole group; a regular
  // member just drops out of it — the only two cases either call site
  // ever needed.
  private removeFromGroup(playerId: string): void {
    const groupId = groupsStore.getGroupIdForPlayer(playerId);
    if (!groupId) return;
    const group = groupsStore.getGroup(groupId);
    if (!group) return;

    if (group.leaderId === playerId) {
      const disbanded = groupsStore.disbandGroup(groupId);
      if (!disbanded) return;
      for (const memberId of disbanded.memberIds) {
        if (memberId === playerId) continue;
        this.deliverToPlayer(memberId, "group:state", { groupId: null, leaderId: null, members: [] });
      }
      return;
    }

    groupsStore.removeMember(playerId);
    if (group.memberIds.size > 0) this.broadcastGroupState(group);
  }

  private broadcastGroupState(group: groupsStore.GroupState) {
    const members = [...group.memberIds].map((playerId) => ({
      playerId,
      name: this.resolveDisplayName(playerId),
    }));
    for (const memberId of group.memberIds) {
      this.deliverToPlayer(memberId, "group:state", { groupId: group.id, leaderId: group.leaderId, members });
    }
  }

  // ---------------------------------------------------------------------
  // Phase 6: clans — persisted alliances (clans/clan_members in Postgres,
  // see db/clans.ts). The invite/accept flow mirrors groups (target a
  // connected player, they get a prompt) but acceptance writes a durable
  // clan_members row instead of just room-memory state.
  // ---------------------------------------------------------------------

  private sendClanResult(client: Client, action: string, ok: boolean, reason?: string) {
    client.send("clanResult", { action, ok, reason });
  }

  // Refreshes both the sessionClanId chat-gating cache and the ship's
  // clanTag/clanColor mirrors (so every connected client can render the
  // tint/flag/tag without a per-player query). Called on join and after
  // every clan mutation that could change this session's membership.
  private async refreshClanState(sessionId: string, playerId: string): Promise<void> {
    const ship = this.state.ships.get(sessionId);
    const membership = await getClanForPlayer(playerId);
    this.sessionClanId.set(sessionId, membership?.clan.id ?? null);

    if (ship) {
      ship.clanTag = membership?.clan.tag ?? "";
      ship.clanColor1 = membership?.clan.flag_color_1 ?? "";
      ship.clanColor2 = membership?.clan.flag_color_2 ?? "";
    }
  }

  private findSessionIdForPlayer(playerId: string): string | null {
    for (const [sessionId, session] of this.playerSessions) {
      if (session.playerId === playerId) return sessionId;
    }
    return null;
  }

  private async sendClanState(client: Client, playerId: string): Promise<void> {
    const membership = await getClanForPlayer(playerId);
    if (!membership) {
      client.send("clan:state", { clan: null, myRank: null, members: [] });
      return;
    }

    const members = await getClanMembers(membership.clan.id);
    client.send("clan:state", { clan: membership.clan, myRank: membership.member.rank, members });
  }

  // Pushes a fresh clan:state to a specific player's session, if currently
  // connected — used after an action (kick/disband/rank change) affects
  // someone other than the acting client. Phase 7 (first slice): that
  // player may now be connected to a different region+channel room than
  // this one, so this resolves their room via the directory rather than
  // assuming same-room delivery like before.
  private async pushClanStateToPlayer(playerId: string): Promise<void> {
    const room = this.roomForPlayer(playerId);
    if (!room) return;
    const sessionId = room.findSessionIdForPlayer(playerId);
    if (!sessionId) return;
    const client = room.findClient(sessionId);
    if (client) await room.sendClanState(client, playerId);
    await room.refreshClanState(sessionId, playerId);
  }

  private async handleClanCreate(client: Client, message: Record<string, unknown>) {
    const session = this.playerSessions.get(client.sessionId);
    if (!session) return;

    const name = String(message?.name ?? "").trim().slice(0, CLAN_NAME_MAX_LENGTH);
    const tag = String(message?.tag ?? "").trim().toUpperCase().slice(0, CLAN_TAG_MAX_LENGTH);
    const flagColor1 = String(message?.flagColor1 ?? "#ffffff");
    const flagColor2 = typeof message?.flagColor2 === "string" ? message.flagColor2 : undefined;
    if (!name || !tag) return this.sendClanResult(client, "create", false, "name and tag are required");

    const result = await createClan(session.playerId, name, tag, flagColor1, flagColor2);
    if (!result.ok || !result.data) return this.sendClanResult(client, "create", false, result.reason);

    const ship = this.state.ships.get(client.sessionId);
    if (ship && result.gold !== undefined) ship.gold = result.gold;
    await this.refreshClanState(client.sessionId, session.playerId);
    this.sendClanResult(client, "create", true);
    await this.sendClanState(client, session.playerId);
  }

  private async handleClanInvite(client: Client, message: { targetSessionId?: string }) {
    const inviterSession = this.playerSessions.get(client.sessionId);
    const targetId = message?.targetSessionId;
    if (!inviterSession || !targetId || targetId === client.sessionId) {
      return this.sendClanResult(client, "invite", false, "invalid target");
    }

    const targetSession = this.playerSessions.get(targetId);
    if (!targetSession) return this.sendClanResult(client, "invite", false, "player not found");

    const inviterClan = await getClanForPlayer(inviterSession.playerId);
    if (!inviterClan || !canActOnClanAs(inviterClan.member, "oficial")) {
      return this.sendClanResult(client, "invite", false, "insufficient rank to invite");
    }

    const targetClan = await getClanForPlayer(targetSession.playerId);
    if (targetClan) return this.sendClanResult(client, "invite", false, "target already in a clan");

    this.pendingClanInvites.set(targetId, {
      clanId: inviterClan.clan.id,
      inviterId: client.sessionId,
      expiresAt: Date.now() + INVITE_EXPIRY_MS,
    });

    this.findClient(targetId)?.send("clan:inviteReceived", {
      fromSessionId: client.sessionId,
      fromName: this.displayNames.get(client.sessionId) ?? "?",
      clanName: inviterClan.clan.name,
      clanTag: inviterClan.clan.tag,
    });
    this.sendClanResult(client, "invite", true);
  }

  private async handleClanRespond(client: Client, message: { accept?: boolean }) {
    const targetId = client.sessionId;
    const invite = this.pendingClanInvites.get(targetId);
    this.pendingClanInvites.delete(targetId);

    if (!invite || invite.expiresAt < Date.now()) {
      return this.sendClanResult(client, "respond", false, "invite expired");
    }
    if (!message?.accept) return this.sendClanResult(client, "respond", true);

    const session = this.playerSessions.get(targetId);
    if (!session) return;

    const result = await joinClan(session.playerId, invite.clanId);
    if (!result.ok) return this.sendClanResult(client, "respond", false, result.reason);

    await this.refreshClanState(targetId, session.playerId);
    this.sendClanResult(client, "respond", true);
    await this.sendClanState(client, session.playerId);
  }

  private async handleClanRename(client: Client, message: { name?: string }) {
    const session = this.playerSessions.get(client.sessionId);
    const name = typeof message?.name === "string" ? message.name.trim().slice(0, CLAN_NAME_MAX_LENGTH) : "";
    if (!session || !name) return this.sendClanResult(client, "rename", false, "invalid name");

    const result = await renameClan(session.playerId, name);
    if (!result.ok) return this.sendClanResult(client, "rename", false, result.reason);

    this.sendClanResult(client, "rename", true);
    await this.sendClanState(client, session.playerId);
  }

  private async handleClanDisband(client: Client) {
    const session = this.playerSessions.get(client.sessionId);
    if (!session) return;

    const result = await disbandClan(session.playerId);
    if (!result.ok || !result.data) return this.sendClanResult(client, "disband", false, result.reason);

    this.sendClanResult(client, "disband", true);
    for (const memberId of result.data.memberIds) {
      await this.pushClanStateToPlayer(memberId);
    }
  }

  private async handleClanLeave(client: Client) {
    const session = this.playerSessions.get(client.sessionId);
    if (!session) return;

    const result = await leaveClan(session.playerId);
    if (!result.ok) return this.sendClanResult(client, "leave", false, result.reason);

    await this.refreshClanState(client.sessionId, session.playerId);
    this.sendClanResult(client, "leave", true);
    await this.sendClanState(client, session.playerId);
  }

  private async handleClanKick(client: Client, message: { targetPlayerId?: string }) {
    const session = this.playerSessions.get(client.sessionId);
    const targetPlayerId = message?.targetPlayerId;
    if (!session || !targetPlayerId) return this.sendClanResult(client, "kick", false, "invalid target");

    const result = await kickClanMember(session.playerId, targetPlayerId);
    if (!result.ok) return this.sendClanResult(client, "kick", false, result.reason);

    this.sendClanResult(client, "kick", true);
    await this.sendClanState(client, session.playerId);
    await this.pushClanStateToPlayer(targetPlayerId);
  }

  private async handleClanSetRank(
    client: Client,
    message: { targetPlayerId?: string },
    rank: Exclude<ClanRank, "capitan">
  ) {
    const session = this.playerSessions.get(client.sessionId);
    const targetPlayerId = message?.targetPlayerId;
    if (!session || !targetPlayerId) return this.sendClanResult(client, "setRank", false, "invalid target");

    const result = await setClanMemberRank(session.playerId, targetPlayerId, rank);
    if (!result.ok) return this.sendClanResult(client, "setRank", false, result.reason);

    this.sendClanResult(client, "setRank", true);
    await this.sendClanState(client, session.playerId);
    await this.pushClanStateToPlayer(targetPlayerId);
  }

  private async handleClanDonate(client: Client, message: { amount?: number }) {
    const session = this.playerSessions.get(client.sessionId);
    const amount = Number(message?.amount);
    if (!session || !Number.isFinite(amount) || amount <= 0) {
      return this.sendClanResult(client, "donate", false, "invalid amount");
    }

    const result = await donateToBank(session.playerId, amount);
    if (!result.ok) return this.sendClanResult(client, "donate", false, result.reason);

    const ship = this.state.ships.get(client.sessionId);
    if (ship && result.gold !== undefined) ship.gold = result.gold;
    this.sendClanResult(client, "donate", true);
    await this.sendClanState(client, session.playerId);
  }

  private async handleClanWithdraw(client: Client, message: { amount?: number }) {
    const session = this.playerSessions.get(client.sessionId);
    const amount = Number(message?.amount);
    if (!session || !Number.isFinite(amount) || amount <= 0) {
      return this.sendClanResult(client, "withdraw", false, "invalid amount");
    }

    const result = await withdrawFromBank(session.playerId, amount);
    if (!result.ok) return this.sendClanResult(client, "withdraw", false, result.reason);

    const ship = this.state.ships.get(client.sessionId);
    if (ship && result.gold !== undefined) ship.gold = result.gold;
    this.sendClanResult(client, "withdraw", true);
    await this.sendClanState(client, session.playerId);
  }

  private async handleClanRoster(client: Client) {
    const session = this.playerSessions.get(client.sessionId);
    if (!session) return;
    await this.sendClanState(client, session.playerId);
  }
}

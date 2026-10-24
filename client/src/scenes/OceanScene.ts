import Phaser from "phaser";
import { Client, Room, getStateCallbacks } from "colyseus.js";
import {
  ACCELERATION,
  AMMO_COST_PER_UNIT,
  CHAT_MAX_MESSAGE_LENGTH,
  COMMODITIES,
  COMMODITY_KEYS,
  COSMETIC_CATALOG,
  COSMETIC_NONE_KEY,
  COSMETIC_SLOTS,
  DEFAULT_REGION_ID,
  DOCK,
  DRAG,
  FLAG_COLOR_OPTIONS,
  getRegion,
  HULL_COLOR_OPTIONS,
  WORLD_WIDTH,
  WORLD_HEIGHT,
  honorPriceMultiplier,
  isDockServiceRefused,
  isNoviceProtected,
  isPirateFlagged,
  isInSafeZone,
  MARKET_COMMISSION_RATE,
  MAX_GROUP_SIZE,
  REPAIR_COST_PER_HULL,
  REVERSE_SPEED_FACTOR,
  SAIL_PATTERN_OPTIONS,
  SHIP_CLASSES,
  stepShip,
  TURN_ACCELERATION,
  UPGRADE_CAPS_BY_CLASS,
  UPGRADE_DEFS,
  WAKE_COLOR_OPTIONS,
  costForUpgradeLevel,
  type CannonSide,
  type ChatChannel,
  type ChatMessage,
  type ClanRank,
  type CommodityKey,
  type CosmeticSlot,
  type RegionDef,
  type ShipClassKey,
  type ShipInput,
  type ShipPhysicsState,
  type UpgradeKey,
} from "@iron-tides/shared";
import { upgradeToAccount } from "../auth";
import { getSession, setSession } from "../session";
import { loadMuteList, isMuted, toggleMute } from "../socialStorage";
import { fetchWeeklyRanking, type RankingEntry } from "../tavern";
import { createTouchControls, isTouchDevice, type TouchControls } from "../touchControls";

// Derived from the page's own origin (not a hardcoded localhost:2567):
// Vite's dev proxy forwards everything under /colyseus (matchmake HTTP +
// the room WebSocket, which colyseus.js always addresses at the same
// host:port:pathname) to the real game server, so this same URL works
// whether the page was loaded from localhost or a tunnel exposing only
// the Vite port.
const SERVER_URL = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/colyseus`;
const INPUT_SEND_INTERVAL_MS = 50;
const INTERP_DELAY_MS = 100;
const RECONCILE_LERP = 0.15;
const SNAP_DISTANCE = 120;
const LOCAL_SHIP_COLOR = 0x4fd8ff;
const REMOTE_SHIP_COLOR = 0xff9240;
// Phase 7 (fourth slice): the weekend-event boss — a distinct dark-purple
// tint (nothing else in the game uses this hue), now applied to a real
// sprite instead of a scaled-up triangle (see ships.onAdd below), so it
// still reads as "giant ship, not a regular bot" at a glance.
const BOSS_SHIP_COLOR = 0x7a1fa2;
const SEA_SIZE = 8000;

// ---------------------------------------------------------------------
// Minimap (top-right corner, fixed HUD, setScrollFactor(0) like every
// other HUD element below — see reloadBarsGraphics/hudText above for the
// existing convention this follows). Per the design doc's minimap spec:
// docks, allies, the current region's border, and nearby enemies.
// Manual world->panel math, same "hand-computed HUD position" convention
// the reload gauges and hull/gold corner already use, rather than a
// second Phaser camera — a second camera buys nothing here since nothing
// on the minimap needs real sprites/animation, just flat colored dots.
// ---------------------------------------------------------------------
const MINIMAP_SIZE = 170;
const MINIMAP_MARGIN = 14;
const MINIMAP_PADDING = 6;
// WORLD_WIDTH === WORLD_HEIGHT (see shared/src/world.ts) so these two
// come out equal in practice, but computed independently so the panel
// still maps without distortion if that ever changes.
const MINIMAP_MAP_SIZE = MINIMAP_SIZE - MINIMAP_PADDING * 2;
const MINIMAP_SCALE_X = MINIMAP_MAP_SIZE / WORLD_WIDTH;
const MINIMAP_SCALE_Y = MINIMAP_MAP_SIZE / WORLD_HEIGHT;

// Other players beyond this world-space radius of the local ship are not
// plotted on the minimap at all. The full room state is already synced to
// every client regardless of this — it's not a new visibility/anti-cheat
// system, purely a client-side declutter choice. 1200px is ~30% of the
// 4000x4000 region's width: close enough to warn of an approaching ship
// well before it's actually on screen, without permanently showing every
// other player in the region.
const MINIMAP_ENEMY_RADIUS = 1200;

const MINIMAP_BG_COLOR = 0x05151f;
const MINIMAP_BORDER_COLOR = 0x1f3b4a;
const MINIMAP_DOCK_COLOR = 0xffd166;
const MINIMAP_SAFE_ZONE_COLOR = 0x8fd8ff;
const MINIMAP_ISLAND_COLOR = 0x8a6d3b;
const MINIMAP_ROCK_COLOR = 0x6b7d85;
const MINIMAP_LOCAL_COLOR = 0x4fd8ff;
// Same gold used for the group-member highlight ring in the main view
// (renderNameAndClanLabels) — reused here for "ally" so the two HUD
// elements agree on what color "ally" means.
const MINIMAP_ALLY_COLOR = 0xffe066;
const MINIMAP_ENEMY_COLOR = 0xe6584f;
const MINIMAP_BORDER_HINT_COLOR = 0xeaffff;

// ---------------------------------------------------------------------
// Sprite-art phase (Kenney.nl Pirate Pack, CC0 — see
// client/public/assets/pirates/CREDIT.txt). Everything below replaces the
// old Phaser.Graphics placeholder shapes with real textures loaded in
// preload(). The atlas is a Starling/Sparrow XML sheet; frame names below
// are copied verbatim from shipsMiscellaneous_sheet.xml.
// ---------------------------------------------------------------------
const SHIP_ATLAS_KEY = "pirate-ships";

// Bug fix (visual-only, see phase report): the hull art is actually drawn
// bow-DOWN, not bow-up as a previous pass assumed. Checked directly against
// the source frame (hullSmall (1).png, 40x108): the wide/rounded end — where
// the sail/flag Images are attached in createShipNode at local y=-18/-64,
// i.e. toward -Y — is the stern; the narrow pointed end with the anchor-hawse
// dot (toward +Y) is the bow. Kenney's own Sample.png confirms ships are
// drawn nose-first the same way.
//
// shared/src/physics.ts's stepShip moves a ship by
// (cos(heading), sin(heading)) * speed — heading=0 is +X, and this is the
// same (cos,sin) convention Phaser's Container rotation uses (0 = local +X
// axis, increasing = toward +Y, matching the canvas's y-down screen space:
// see getCannonFiringOrigin's "Canvas y is down" comment). The art's native
// bow direction is local +Y (angle +90°/π/2 in that convention), so to make
// the bow point along `heading` after rotation, the rotation applied must be
// `heading - 90°`, not `heading + 90°`. The previous +π/2 offset was exactly
// 180° off from correct, which is what made the ship appear to travel bow
// -first in the *opposite* direction of actual movement (looks like
// reversing) rather than merely sideways.
const SHIP_FACING_OFFSET = -Math.PI / 2;

interface ShipVisualConfig {
  hullFrame: string;
  sailFrame: string;
  scale: number;
}

// Phase: real ship art. Balandra (free starter) gets the small hull at a
// reduced scale so it reads as nimble; Galeón gets the large hull at the
// biggest scale so it reads as the heaviest class; Mercante also uses the
// large hull (it needs the hull's visual bulk for its huge cargo hold) but
// a distinct hull/sail variant index and a slightly smaller scale than
// Galeón so the two don't look identical. Bergantín sits in between on the
// small hull. These are purely visual picks — none of this feeds back into
// shared/src/shipClasses.ts's actual stats.
const SHIP_CLASS_VISUALS: Record<string, ShipVisualConfig> = {
  balandra: { hullFrame: "hullSmall (1).png", sailFrame: "sailSmall (1).png", scale: 0.85 },
  bergantin: { hullFrame: "hullSmall (3).png", sailFrame: "sailLarge (1).png", scale: 1.0 },
  galeon: { hullFrame: "hullLarge (1).png", sailFrame: "sailLarge (5).png", scale: 1.25 },
  mercante: { hullFrame: "hullLarge (3).png", sailFrame: "sailLarge (9).png", scale: 1.1 },
};
const DEFAULT_SHIP_VISUAL = SHIP_CLASS_VISUALS.balandra;

// Bots/boss use the pack's 24 fully-colored complete ship sprites directly
// (no per-ship tinting — see shipDisplayColor's callers). Pools of the
// skull & crossbones variants (pirates) and the blank/cross variants
// (merchants), picked deterministically per sessionId so a cluster of bots
// isn't one single repeated sprite.
const PIRATE_SHIP_FRAMES = ["ship (2).png", "ship (8).png", "ship (14).png"];
const MERCHANT_SHIP_FRAMES = ["ship (1).png", "ship (3).png", "ship (7).png", "ship (9).png"];
const BOSS_SHIP_FRAME = "ship (2).png";

function pickFrame(pool: string[], seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return pool[hash % pool.length];
}

// A player ship is a Container of three tintable parts (hull/sail/flag); a
// bot/boss ship is a single pre-colored Image. Both expose the same
// Transform/Visible/Alpha surface (setPosition/setRotation/x/y/visible/
// angle/alpha/destroy), so shipRoot() below is what every render function
// that only moves/reads the ship (health bars, labels, interpolation...)
// actually operates on — same single-node shape the old Triangle map gave
// them, just resolved from the richer union first.
interface PlayerShipNode {
  kind: "player";
  container: Phaser.GameObjects.Container;
  hull: Phaser.GameObjects.Image;
  sail: Phaser.GameObjects.Image;
  flag: Phaser.GameObjects.Image;
}
interface NpcShipNode {
  kind: "npc";
  image: Phaser.GameObjects.Image;
}
type ShipNode = PlayerShipNode | NpcShipNode;

function shipRoot(node: ShipNode): Phaser.GameObjects.Container | Phaser.GameObjects.Image {
  return node.kind === "player" ? node.container : node.image;
}

const SINK_ANIM_MS = 1500;
const RESPAWN_FADE_MS = 400;
const HEALTH_BAR_WIDTH = 28;
const HEALTH_BAR_HEIGHT = 4;
const HEALTH_BAR_OFFSET_Y = -22;
// Phase 7 (fourth slice): boss health bar — bigger bar + further offset to
// clear the larger triangle (see BOSS_SHIP_COLOR above).
const BOSS_HEALTH_BAR_WIDTH = 64;
const BOSS_HEALTH_BAR_HEIGHT = 7;
const BOSS_HEALTH_BAR_OFFSET_Y = -34;
const CANNONBALL_TRAIL_LENGTH = 5;
// Phase 7 (fifth/final slice): wake cosmetic trail — a few points longer
// than the cannonball trail since it's sampled once per render frame
// rather than once per server state update, same "short fading trail of
// recent positions" technique as CANNONBALL_TRAIL_LENGTH just above.
const WAKE_TRAIL_LENGTH = 10;
const LOOT_BOB_AMPLITUDE = 4;
const LOOT_BOB_SPEED = 0.004;

type DockTab = "shipyard" | "repair" | "market" | "armory" | "upgrades" | "cosmetics" | "tavern";

// Phase 7 (fifth/final slice): player-to-player market listing, as pushed
// by OceanRoom's market:listings message — isMine is computed server-side
// (the room knows the requesting session's playerId; ShipSchema itself
// deliberately never exposes raw player ids to the client, same reasoning
// as renderNameAndClanLabels's group-highlight comment).
interface MarketListingView {
  id: string;
  sellerDisplayName: string;
  commodity: CommodityKey;
  quantity: number;
  pricePerUnit: number;
  createdAt: string;
  isMine: boolean;
}

const COSMETIC_SLOT_LABELS: Record<CosmeticSlot, string> = {
  hullColor: "Color de casco",
  sailPattern: "Patrón de velas",
  flagColor: "Bandera personal",
  wakeColor: "Estela",
};

// Phase 5: the full Tavern bundle pushed by the server on tavern:open /
// tavern:refresh / after any mutating action — see OceanRoom.sendTavernState.
interface TavernState {
  dailyTasks: {
    id: string;
    task_type: string;
    target: number;
    progress: number;
    reward_gold: number;
    claimed: boolean;
  }[];
  rerollAvailable: boolean;
  missions: {
    id: string;
    mission_type: "caza" | "escolta" | "exploracion";
    params: Record<string, unknown>;
    progress: number;
    target: number;
    reward_gold: number;
    status: string;
  }[];
  offers: {
    type: "caza" | "escolta" | "exploracion";
    title: string;
    description: string;
    rewardGold: number;
  }[];
  streak: { count: number; lastLoginDate: string | null };
  weeklyChallenges: {
    key: string;
    title: string;
    threshold: number;
    rewardGold: number;
    progress: number;
    claimed: boolean;
  }[];
  achievements: {
    key: string;
    title: string;
    description: string;
    threshold: number;
    rewardGold: number;
    rewardTitle?: string;
    unlocked: boolean;
    unlockedAt: string | null;
  }[];
  gold: number;
  title: string | null;
}

const DAILY_TASK_LABELS: Record<string, string> = {
  earn_gold: "Ganar oro",
  fire_cannons: "Disparar cañones",
  complete_missions: "Completar misiones",
};

const TAVERN_REFRESH_INTERVAL_MS = 3000;

interface OwnedShipSummary {
  id: string;
  classKey: string;
  hull: number;
  isActive: boolean;
}

interface RemoteSample {
  state: ShipPhysicsState;
  t: number;
}

interface CannonballVisual {
  ball: any;
  sprite: Phaser.GameObjects.Image;
  trail: Phaser.GameObjects.Graphics;
  history: { x: number; y: number }[];
}

interface LootVisual {
  marker: Phaser.GameObjects.Arc;
  baseY: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

export class OceanScene extends Phaser.Scene {
  private room!: Room<any>;
  // Phase 7 (first slice): which region+channel the current room is, read
  // straight off room.state (synced, so no join-order race — see
  // server/src/schema/OceanState.ts) — used for the HUD line and to redraw
  // this region's island/rock layout on initial connect and again after
  // every border-crossing transfer.
  private currentRegionId = "";
  private currentChannel = 1;
  // Phase: real ship art — safe-zone ring stays a cheap Graphics overlay;
  // islands/rocks/dock are now real Image sprites, tracked here so they can
  // be destroyed and rebuilt on every region transfer (same "redrawn on
  // every border-crossing" lifecycle the old Graphics-based version had).
  private worldGeometryGfx!: Phaser.GameObjects.Graphics;
  private worldGeometryImages: Phaser.GameObjects.Image[] = [];
  private sea!: Phaser.GameObjects.TileSprite;
  private shipVisuals = new Map<string, ShipNode>();
  private shipSchemas = new Map<string, any>();
  private sunkVisually = new Map<string, boolean>();
  private remoteBuffers = new Map<string, RemoteSample[]>();
  private cannonballVisuals = new Map<string, CannonballVisual>();
  private lootVisuals = new Map<string, LootVisual>();
  private predicted: ShipPhysicsState | null = null;
  private serverLocal: ShipPhysicsState | null = null;
  private shipInput: ShipInput = { throttle: 0, turn: 0 };
  private lastSentInput: ShipInput = { throttle: 0, turn: 0 };
  private sendAccumulatorMs = 0;
  private keyW!: Phaser.Input.Keyboard.Key;
  private keyS!: Phaser.Input.Keyboard.Key;
  private keyA!: Phaser.Input.Keyboard.Key;
  private keyD!: Phaser.Input.Keyboard.Key;
  private keyQ!: Phaser.Input.Keyboard.Key;
  private keyE!: Phaser.Input.Keyboard.Key;
  private keyB!: Phaser.Input.Keyboard.Key;
  private healthBarsGraphics!: Phaser.GameObjects.Graphics;
  private hudText!: Phaser.GameObjects.Text;
  private reloadBarsGraphics!: Phaser.GameObjects.Graphics;
  private minimapGraphics!: Phaser.GameObjects.Graphics;

  // Phase 7 (third slice): virtual joystick + fire buttons, only created on
  // touch-capable devices (see isTouchDevice) — null on desktop, where
  // readInput() falls back to keyboard-only exactly as before.
  private touchControls: TouchControls | null = null;

  // Phase 4 dock UI: a plain DOM panel toggled while docked in the safe
  // zone, kept separate from the Phaser canvas. Presented as a centered
  // modal (dockBackdropEl dims the game behind it) rather than a corner box.
  private dockPanelEl!: HTMLDivElement;
  private dockBackdropEl!: HTMLDivElement;
  private dockHintEl!: HTMLDivElement;
  private dockOpen = false;
  private activeDockTab: DockTab = "shipyard";
  private ownedShips: OwnedShipSummary[] = [];

  // Phase 7 (second slice): Mercado tab commodity prices for the region the
  // dock we're currently inside belongs to — pushed fresh after every
  // dock:listPrices request and after every buy/sell (see dock:prices).
  private dockPrices: { commodity: CommodityKey; currentPrice: number; basePrice: number }[] = [];

  // Phase 7 (fifth/final slice): player-to-player listings at this dock —
  // pushed fresh after market:listListings and after every create/cancel/
  // buy, same "always refetch, never locally patch" convention as dockPrices.
  private marketListings: MarketListingView[] = [];

  // Phase 5: Tavern tab state.
  private tavernState: TavernState | null = null;
  private tavernRefreshAccumulatorMs = 0;
  private rankingMetric: "gold_earned" | "bots_sunk" = "gold_earned";
  private rankingEntries: RankingEntry[] | null = null;
  private rankingLoading = false;
  private accountCornerEl: HTMLDivElement | null = null;

  // Phase 6: social (chat, groups, clans, reputation). A plain DOM panel
  // pair, same "simple tabbed panel" approach as the dock UI.
  private chatPanelEl!: HTMLDivElement;
  private chatInputEl!: HTMLInputElement;
  private chatMessagesEl!: HTMLDivElement;
  private chatChannel: ChatChannel = "zone";
  private chatMessages: ChatMessage[] = [];
  private chatInputFocused = false;

  private socialPanelEl!: HTMLDivElement;
  private socialOpen = false;
  private keyN!: Phaser.Input.Keyboard.Key;

  // Phase 7 (first slice): leaderId/members are keyed by persistent
  // playerId now (group membership survives a member border-crossing into
  // a different region+channel room — see server/src/world/groups.ts),
  // not the volatile session id of before.
  private groupState: { groupId: string | null; leaderId: string | null; members: { playerId: string; name: string }[] } =
    { groupId: null, leaderId: null, members: [] };
  private pendingGroupInvite: { fromSessionId: string; fromName: string; groupId: string } | null = null;

  private clanState: {
    clan: { id: string; name: string; tag: string; flag_color_1: string; flag_color_2: string | null; bank_gold: number } | null;
    myRank: ClanRank | null;
    members: { player_id: string; display_name: string; rank: ClanRank }[];
  } = { clan: null, myRank: null, members: [] };
  private pendingClanInvite: { fromSessionId: string; fromName: string; clanName: string; clanTag: string } | null = null;

  // Per-ship clan flag/name/pirate-indicator overlays, keyed by sessionId —
  // built lazily alongside the triangle visuals in ships.onAdd.
  private nameLabels = new Map<string, Phaser.GameObjects.Text>();
  private clanFlags = new Map<string, Phaser.GameObjects.Graphics>();
  private reputationGraphics!: Phaser.GameObjects.Graphics;
  private reputationTexts = new Map<string, Phaser.GameObjects.Text>();

  // Phase 7 (fourth slice): weekend event banner + boss health-bar labels.
  private weekendBannerText!: Phaser.GameObjects.Text;
  private bossLabels = new Map<string, Phaser.GameObjects.Text>();

  // Phase 7 (fifth/final slice), still true with real sprites: the wake
  // trail cosmetic is a single shared Graphics object cleared and fully
  // redrawn every frame, same "one Graphics for every ship" approach as
  // healthBarsGraphics/reputationGraphics above — hull/sail/flag cosmetics
  // moved onto the ship sprites themselves (see createShipNode /
  // refreshPlayerShipVisual), so this is the one cosmetic slot that still
  // needs a per-frame Graphics redraw. wakeHistories is the one piece of
  // per-ship state that does need to persist frame-to-frame (a short trail
  // of recent render positions), keyed by sessionId like every other
  // per-ship map in this class.
  private wakeGfx!: Phaser.GameObjects.Graphics;
  private wakeHistories = new Map<string, { x: number; y: number }[]>();

  constructor() {
    super("ocean");
  }

  // Phase: real ship art. Every texture the game uses lives under
  // client/public/assets/pirates/ (vendored from the Kenney.nl Pirate Pack,
  // CC0 — see that directory's CREDIT.txt), served by Vite's default
  // public-dir convention at the same absolute paths used below.
  preload() {
    this.load.atlasXML(
      SHIP_ATLAS_KEY,
      "/assets/pirates/ships/shipsMiscellaneous_sheet.png",
      "/assets/pirates/ships/shipsMiscellaneous_sheet.xml"
    );
    this.load.image("fx-explosion1", "/assets/pirates/effects/explosion1.png");
    this.load.image("fx-explosion2", "/assets/pirates/effects/explosion2.png");
    this.load.image("fx-explosion3", "/assets/pirates/effects/explosion3.png");
    this.load.image("fx-fire1", "/assets/pirates/effects/fire1.png");
    this.load.image("fx-fire2", "/assets/pirates/effects/fire2.png");
    // Curated, individually-cropped tile files (see this file's top-level
    // comment and the phase report for exactly which tile_NN indices these
    // are and why the rest of the sheet was excluded).
    //
    // Islands: tile_01/07/33/etc are individual pieces of Kenney's
    // assemble-yourself island tileset (a rounded corner, an edge band,
    // ...) — the pack ships no single standalone "complete island" sprite
    // (confirmed against Sample.png, which shows every island on screen
    // built the same way: a grid of these corner/edge/fill tiles). Baked
    // once, offline (see client/public/assets/pirates/tiles — not
    // generated at runtime), into two complete composite PNGs so each
    // island renders as one real rounded/organic shape with correct
    // transparency instead of one tile stretched into a rectangle:
    //   - island_plain.png: 3x3 grid of tile_01/02/03 (top corners+edge),
    //     tile_17/18/19 (middle), tile_33/34/35 (bottom corners+edge) —
    //     a plain sand island.
    //   - island_lush.png: 4x4 grid of tile_06..09/22..25/38..41/54..57 —
    //     a sand-bordered island with a grass/foliage interior.
    // Only two distinct complete island shapes exist in the source pack,
    // so both island frame keys below map onto them (cycled by index in
    // createWorldGeometry, same as before).
    this.load.image("tile-island-a", "/assets/pirates/tiles/island_plain.png");
    this.load.image("tile-island-b", "/assets/pirates/tiles/island_lush.png");
    this.load.image("tile-rock-a", "/assets/pirates/tiles/tile_49.png");
    this.load.image("tile-rock-b", "/assets/pirates/tiles/tile_65.png");
    this.load.image("tile-dock", "/assets/pirates/tiles/tile_60.png");
  }

  create() {
    this.createSea();
    this.createWorldGeometry(getRegion(DEFAULT_REGION_ID));

    const keyboard = this.input.keyboard!;
    this.keyW = keyboard.addKey("W");
    this.keyS = keyboard.addKey("S");
    this.keyA = keyboard.addKey("A");
    this.keyD = keyboard.addKey("D");
    this.keyQ = keyboard.addKey("Q");
    this.keyE = keyboard.addKey("E");
    this.keyB = keyboard.addKey("B");
    this.keyN = keyboard.addKey("N");

    this.input.mouse?.disableContextMenu();
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (this.chatInputFocused) return;
      if (pointer.leftButtonDown()) this.fire("port");
      else if (pointer.rightButtonDown()) this.fire("starboard");
    });

    this.healthBarsGraphics = this.add.graphics().setDepth(5);
    this.reputationGraphics = this.add.graphics().setDepth(6);
    // wakeGfx sits just above the sea/world-geometry layers but below the
    // ship sprites themselves (depth 0), so a tinted wake trail reads as
    // "behind the ship" the way a real wake would.
    this.wakeGfx = this.add.graphics().setDepth(-1);
    this.reloadBarsGraphics = this.add.graphics().setDepth(100).setScrollFactor(0);
    this.minimapGraphics = this.add.graphics().setDepth(100).setScrollFactor(0);
    this.hudText = this.add
      .text(16, 16, "", { fontFamily: "monospace", fontSize: "16px", color: "#eaffff" })
      .setDepth(100)
      .setScrollFactor(0);

    // Phase 7 (fourth slice): persistent weekend-event banner, top-center.
    // Visibility is driven straight off the synced OceanState.weekendEventActive
    // field each frame (see renderWeekendBanner) — no separate client-side
    // date check, so it can never disagree with the server's gate.
    this.weekendBannerText = this.add
      .text(this.scale.width / 2, 12, "", {
        fontFamily: "monospace",
        fontSize: "14px",
        color: "#1a1206",
        backgroundColor: "#ffd166",
        padding: { x: 10, y: 4 },
      })
      .setOrigin(0.5, 0)
      .setDepth(100)
      .setScrollFactor(0)
      .setVisible(false);

    this.createDockUI();
    this.createAccountUI();
    this.createChatUI();
    this.createSocialUI();

    // Detected via the Pointer Events / Touch APIs, never user-agent
    // sniffing, so a mouse/keyboard session never sees these overlays.
    // Created last, after the chat panel, since its reposition() logic
    // measures the chat panel's real on-screen rect to avoid overlapping it.
    if (isTouchDevice()) {
      this.touchControls = createTouchControls((side) => this.fire(side));
    }

    this.connect();
  }

  // Phase: real ship art — water tile call. The pack's one water-looking
  // tile (tile_73.png) is a single flat pale-blue square with no texture of
  // its own; tiled as a TileSprite it reads as a worse, flatter result than
  // this richer procedural pattern (multiple depths of wave ellipses +
  // speckle highlights instead of the old two-ellipse version), so per the
  // task's own fallback guidance this stays a programmatic generateTexture
  // fill rather than forcing a bad tile — documented here, not used.
  private createSea() {
    const g = this.add.graphics();
    g.fillStyle(0x0a3d57, 1);
    g.fillRect(0, 0, 64, 64);
    g.fillStyle(0x0e4d6b, 1);
    g.fillEllipse(16, 20, 26, 8);
    g.fillEllipse(44, 48, 30, 8);
    g.fillStyle(0x125e82, 1);
    g.fillEllipse(32, 10, 14, 4);
    g.fillEllipse(8, 50, 12, 4);
    g.fillStyle(0x4fd8ff, 0.12);
    g.fillCircle(50, 14, 2);
    g.fillCircle(10, 34, 1.5);
    g.fillCircle(58, 56, 1.5);
    g.generateTexture("sea-tile", 64, 64);
    g.destroy();

    this.sea = this.add.tileSprite(0, 0, SEA_SIZE, SEA_SIZE, "sea-tile");
    this.sea.setDepth(-10);
  }

  // World geometry: islands/rocks/dock are now real Image sprites scaled to
  // each feature's existing radius (gameplay radii/collision are untouched
  // — only how they're drawn changed); the safe-zone ring stays a cheap
  // Graphics stroke circle, same as before. Phase 7 (first slice): islands/
  // rocks vary per region, so every border-crossing transfer destroys the
  // previous region's sprites and rebuilds this region's layout — see
  // attachRoom.
  private createWorldGeometry(region: RegionDef) {
    if (!this.worldGeometryGfx) this.worldGeometryGfx = this.add.graphics().setDepth(-5);
    this.worldGeometryGfx.clear();

    for (const img of this.worldGeometryImages) img.destroy();
    this.worldGeometryImages = [];

    const islandFrames = ["tile-island-a", "tile-island-b"];
    region.islands.forEach((island, i) => {
      const img = this.add
        .image(island.x, island.y, islandFrames[i % islandFrames.length])
        .setDisplaySize(island.radius * 2.1, island.radius * 2.1)
        .setDepth(-5);
      this.worldGeometryImages.push(img);
    });

    const rockFrames = ["tile-rock-a", "tile-rock-b"];
    region.rocks.forEach((rock, i) => {
      const img = this.add
        .image(rock.x, rock.y, rockFrames[i % rockFrames.length])
        .setDisplaySize(rock.radius * 2.2, rock.radius * 2.2)
        .setAngle((i * 47) % 360)
        .setDepth(-5);
      this.worldGeometryImages.push(img);
    });

    this.worldGeometryGfx.lineStyle(2, 0x8fd8ff, 0.35);
    this.worldGeometryGfx.strokeCircle(DOCK.x, DOCK.y, DOCK.safeRadius);

    const dock = this.add.image(DOCK.x, DOCK.y, "tile-dock").setDisplaySize(48, 48).setDepth(-4);
    this.worldGeometryImages.push(dock);
  }

  private async connect() {
    const session = getSession();
    if (!session) {
      // main.ts always gates game boot behind a session; this is defensive.
      throw new Error("Iron Tides: no session token — cannot join the room");
    }

    const client = new Client(SERVER_URL);
    const room = await client.joinOrCreate("ocean", { token: session.token });
    this.attachRoom(room);
  }

  // Wires every state/message listener onto a room — called once for the
  // initial join and again for every border-crossing transfer (see
  // handleRegionTransfer), since a transfer connects to a brand new Room
  // instance (new sessionId, new WebSocket) rather than reusing this one.
  private attachRoom(room: Room<any>) {
    this.room = room;
    const $ = getStateCallbacks(room);
    const state = room.state;

    this.currentRegionId = state.regionId;
    this.currentChannel = state.channel;
    this.createWorldGeometry(getRegion(this.currentRegionId));

    $(state).ships.onAdd((ship: any, sessionId: string) => {
      const isLocal = sessionId === this.room.sessionId;
      const isBoss = ship.kind === "boss";
      const node = this.createShipNode(ship, isLocal, isBoss, sessionId);
      const root = shipRoot(node);
      this.shipVisuals.set(sessionId, node);
      this.shipSchemas.set(sessionId, ship);
      this.sunkVisually.set(sessionId, false);

      const snapshot: ShipPhysicsState = {
        x: ship.x,
        y: ship.y,
        heading: ship.heading,
        speed: ship.speed,
      };

      if (isLocal) {
        this.predicted = { ...snapshot };
        this.serverLocal = { ...snapshot };
        this.cameras.main.startFollow(root, true, 0.15, 0.15);
      } else {
        this.remoteBuffers.set(sessionId, [{ state: snapshot, t: Date.now() }]);
      }

      $(ship).onChange(() => {
        // Phase 7 (fifth/final slice): cosmeticHullColor/sailPattern/flag
        // can change mid-session (buying a cosmetic at the dock, or a clan
        // change) — this call is cheap and idempotent, so just recomputing
        // every tint on every change rather than listening for specific
        // fields is simpler and matches this handler's existing "just
        // recompute from the live schema" style. NPCs never carry cosmetics
        // (no catalog entry matches their "" cosmetic strings), so this is
        // a safe no-op for them.
        if (node.kind === "player") this.refreshPlayerShipVisual(node, ship, isLocal);

        const next: ShipPhysicsState = {
          x: ship.x,
          y: ship.y,
          heading: ship.heading,
          speed: ship.speed,
        };

        if (sessionId === this.room.sessionId) {
          this.serverLocal = next;
          if (this.dockOpen) this.renderDockTab();
        } else {
          const buffer = this.remoteBuffers.get(sessionId) ?? [];
          buffer.push({ state: next, t: Date.now() });
          while (buffer.length > 8) buffer.shift();
          this.remoteBuffers.set(sessionId, buffer);
        }

        const wasSunkVisually = this.sunkVisually.get(sessionId) ?? false;
        if (ship.sunk && !wasSunkVisually) {
          this.sunkVisually.set(sessionId, true);
        } else if (!ship.sunk && wasSunkVisually) {
          this.sunkVisually.set(sessionId, false);
          this.playRespawnFadeIn(sessionId);
        }
      });
    });

    $(state).ships.onRemove((_ship: any, sessionId: string) => {
      const node = this.shipVisuals.get(sessionId);
      if (node) this.destroyShipNode(node);
      this.shipVisuals.delete(sessionId);
      this.shipSchemas.delete(sessionId);
      this.sunkVisually.delete(sessionId);
      this.remoteBuffers.delete(sessionId);

      this.nameLabels.get(sessionId)?.destroy();
      this.nameLabels.delete(sessionId);
      this.clanFlags.get(sessionId)?.destroy();
      this.clanFlags.delete(sessionId);
      this.reputationTexts.get(sessionId)?.destroy();
      this.reputationTexts.delete(sessionId);
      this.bossLabels.get(sessionId)?.destroy();
      this.bossLabels.delete(sessionId);
    });

    $(state).cannonballs.onAdd((ball: any, id: string) => {
      const sprite = this.add.image(ball.x, ball.y, SHIP_ATLAS_KEY, "cannonBall.png").setDepth(4);
      const trail = this.add.graphics().setDepth(4);
      const visual: CannonballVisual = { ball, sprite, trail, history: [{ x: ball.x, y: ball.y }] };
      this.cannonballVisuals.set(id, visual);

      if (ball.ownerId === this.room.sessionId) {
        this.spawnMuzzleFlash(ball.x, ball.y);
      }

      $(ball).onChange(() => {
        visual.history.push({ x: ball.x, y: ball.y });
        while (visual.history.length > CANNONBALL_TRAIL_LENGTH) visual.history.shift();
      });
    });

    $(state).cannonballs.onRemove((_ball: any, id: string) => {
      const visual = this.cannonballVisuals.get(id);
      visual?.sprite.destroy();
      visual?.trail.destroy();
      this.cannonballVisuals.delete(id);
    });

    $(state).loot.onAdd((loot: any, id: string) => {
      // Phase 7 (second slice): scavengable cargo lost on a sunk ship (see
      // OceanRoom.handleCargoLossOnSink) reuses this exact marker, just
      // tinted brown instead of gold so it reads as "cargo" at a glance.
      const isCargo = !!loot.commodity;
      const marker = this.add.circle(loot.x, loot.y, 6, isCargo ? 0xcf9b56 : 0xffe066, 0.9).setDepth(3);
      marker.setStrokeStyle(2, isCargo ? 0xead9bf : 0xfff6cc, 0.8);
      this.lootVisuals.set(id, { marker, baseY: loot.y });
    });

    $(state).loot.onRemove((_loot: any, id: string) => {
      const visual = this.lootVisuals.get(id);
      if (visual) {
        this.spawnLootPop(visual.marker.x, visual.marker.y);
        visual.marker.destroy();
      }
      this.lootVisuals.delete(id);
    });

    this.room.onMessage("hit", (payload: any) => {
      this.spawnDamageNumber(payload.x, payload.y, payload.damage);
      this.spawnHitFlash(payload.x, payload.y);

      if (payload.targetId === this.room.sessionId) {
        this.cameras.main.shake(220, 0.012);
      } else if (payload.shooterId === this.room.sessionId) {
        this.cameras.main.shake(100, 0.004);
      }
    });

    this.room.onMessage("sunk", (payload: any) => {
      this.playSinkAnimation(payload.sessionId);
    });

    this.room.onMessage("splash", (payload: any) => {
      this.spawnSplashPuff(payload.x, payload.y);
    });

    this.room.onMessage("dockResult", (payload: { action: string; ok: boolean; reason?: string }) => {
      this.handleDockResult(payload);
    });

    this.room.onMessage("dock:ships", (payload: { ships: OwnedShipSummary[] }) => {
      this.ownedShips = payload.ships;
      if (this.dockOpen && this.activeDockTab === "shipyard") this.renderDockTab();
    });

    this.room.onMessage(
      "dock:prices",
      (payload: { regionId: string; prices: { commodity: CommodityKey; currentPrice: number; basePrice: number }[] }) => {
        this.dockPrices = payload.prices;
        if (this.dockOpen && this.activeDockTab === "market") this.renderDockTab();
      }
    );

    this.room.onMessage("market:listings", (payload: { regionId: string; listings: MarketListingView[] }) => {
      this.marketListings = payload.listings;
      if (this.dockOpen && this.activeDockTab === "market") this.renderDockTab();
    });

    this.room.onMessage("tavern:state", (payload: TavernState) => {
      this.tavernState = payload;
      this.updateAccountCornerTitle();
      if (this.dockOpen && this.activeDockTab === "tavern") this.renderDockTab();
    });

    this.room.onMessage("tavernResult", (payload: { action: string; ok: boolean; reason?: string }) => {
      if (!payload.ok) {
        console.warn(`[tavern] ${payload.action} failed: ${payload.reason ?? "unknown reason"}`);
      }
    });

    // Phase 6: chat / groups / clans.
    this.room.onMessage("chat:message", (payload: ChatMessage) => this.handleChatMessage(payload));
    this.room.onMessage("chatResult", (payload: { ok: boolean; reason?: string }) => {
      if (!payload.ok) console.warn(`[chat] failed: ${payload.reason ?? "unknown reason"}`);
    });

    this.room.onMessage(
      "group:inviteReceived",
      (payload: { fromSessionId: string; fromName: string; groupId: string }) => {
        this.pendingGroupInvite = payload;
        this.renderSocialPanel();
      }
    );
    this.room.onMessage(
      "group:state",
      (payload: { groupId: string | null; leaderId: string | null; members: { playerId: string; name: string }[] }) => {
        this.groupState = payload;
        this.renderSocialPanel();
      }
    );
    this.room.onMessage("groupResult", (payload: { action: string; ok: boolean; reason?: string }) => {
      if (!payload.ok) console.warn(`[group] ${payload.action} failed: ${payload.reason ?? "unknown reason"}`);
    });

    this.room.onMessage(
      "clan:inviteReceived",
      (payload: { fromSessionId: string; fromName: string; clanName: string; clanTag: string }) => {
        this.pendingClanInvite = payload;
        this.renderSocialPanel();
      }
    );
    this.room.onMessage("clan:state", (payload: typeof this.clanState) => {
      this.clanState = payload;
      this.renderSocialPanel();
    });
    this.room.onMessage("clanResult", (payload: { action: string; ok: boolean; reason?: string }) => {
      if (!payload.ok) console.warn(`[clan] ${payload.action} failed: ${payload.reason ?? "unknown reason"}`);
      else this.renderSocialPanel();
    });

    // Phase 7 (first slice): seamless cross-region transfer. The server
    // reserves a seat in the neighboring region's room (or one of its
    // channels) and hands us the exact reservation object
    // matchMaker.joinOrCreate() returned it server-side — we just consume
    // it directly, which connects straight to that room by id/sessionId,
    // no fresh HTTP matchmake or re-login round-trip.
    room.onMessage("region:transfer", (reservation: any) => this.handleRegionTransfer(reservation));

    room.send("clan:roster");
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => this.time.delayedCall(ms, resolve));
  }

  private async handleRegionTransfer(reservation: any) {
    const previousRoom = this.room;

    // Brief fade, not a loading screen — the whole point of the
    // reservation-based handoff is that there's nothing to actually load.
    this.cameras.main.fadeOut(180, 5, 21, 31);
    await this.wait(180);

    try {
      const client = new Client(SERVER_URL);
      const newRoom = await client.consumeSeatReservation(reservation);
      this.resetForRoomSwitch();
      this.attachRoom(newRoom);
      previousRoom.leave(); // consented === true server-side; see OceanRoom.onLeave
    } catch (err) {
      console.error("[OceanScene] failed to consume region transfer seat reservation", err);
    }

    this.cameras.main.fadeIn(180, 5, 21, 31);
  }

  // Tears down every visual tied to the room we're leaving before wiring
  // up the new one — session ids (and the whole set of nearby ships) are
  // entirely different in the new region+channel room.
  private resetForRoomSwitch() {
    for (const v of this.shipVisuals.values()) this.destroyShipNode(v);
    this.shipVisuals.clear();
    this.shipSchemas.clear();
    this.sunkVisually.clear();
    this.remoteBuffers.clear();

    for (const v of this.cannonballVisuals.values()) {
      v.sprite.destroy();
      v.trail.destroy();
    }
    this.cannonballVisuals.clear();

    for (const v of this.lootVisuals.values()) v.marker.destroy();
    this.lootVisuals.clear();

    for (const label of this.nameLabels.values()) label.destroy();
    this.nameLabels.clear();
    for (const flag of this.clanFlags.values()) flag.destroy();
    this.clanFlags.clear();
    for (const text of this.reputationTexts.values()) text.destroy();
    this.reputationTexts.clear();
    this.wakeHistories.clear();

    this.predicted = null;
    this.serverLocal = null;
  }

  update(_time: number, deltaMs: number) {
    const dt = deltaMs / 1000;
    this.sea.tilePositionX += dt * 6;
    this.sea.tilePositionY += dt * 3;

    if (!this.room) return;

    this.readInput();
    this.sendInput(deltaMs);
    this.advanceLocalPrediction(dt);
    this.renderRemoteShips();
    this.renderHealthBars();
    this.renderReputationIndicators();
    this.renderNameAndClanLabels();
    this.renderShipCosmetics();
    this.renderCannonballs();
    this.renderLoot(_time);
    this.renderHud();
    this.renderMinimap();
    this.renderWeekendBanner();
    this.updateDockVisibility(deltaMs);
  }

  // Phase 7 (fourth slice): mirrors OceanState.weekendEventActive 1:1 —
  // the server recomputes that field every tick (see OceanRoom.tickWeekendEvent).
  private renderWeekendBanner() {
    const active = !!this.room?.state?.weekendEventActive;
    this.weekendBannerText.setVisible(active);
    if (active) {
      this.weekendBannerText.setText("⚔ EVENTO DE FIN DE SEMANA: Oro x2 + Jefes activos ⚔");
    }
  }

  private readInput() {
    // While the chat input has focus, every movement/fire/dock key is
    // typing text instead — don't let WASD/Q/E/B leak through to the ship.
    if (this.chatInputFocused) {
      this.shipInput = { throttle: 0, turn: 0 };
      return;
    }

    const keyThrottle = this.keyW.isDown ? 1 : this.keyS.isDown ? -1 : 0;
    const keyTurn = this.keyD.isDown ? 1 : this.keyA.isDown ? -1 : 0;
    const touchInput = this.touchControls?.getInput();

    // Touch axes win when the joystick is actively deflected (non-zero);
    // otherwise fall back to keyboard — lets a touch device with an
    // attached keyboard still use WASD when the thumb isn't on the stick.
    const throttle = touchInput?.throttle || keyThrottle;
    const turn = touchInput?.turn || keyTurn;
    this.shipInput = { throttle, turn };

    if (Phaser.Input.Keyboard.JustDown(this.keyQ)) this.fire("port");
    if (Phaser.Input.Keyboard.JustDown(this.keyE)) this.fire("starboard");
    if (Phaser.Input.Keyboard.JustDown(this.keyN)) this.toggleSocialPanel();
  }

  private fire(side: CannonSide) {
    const ship = this.shipSchemas.get(this.room?.sessionId);
    if (!ship || ship.sunk) return;

    // Client-visible gate is only for UI responsiveness; the server
    // re-validates reload and ammo independently and is free to reject this.
    const remaining = side === "port" ? ship.portReloadRemaining : ship.starboardReloadRemaining;
    if (remaining > 0) return;
    if (ship.ammo < ship.cannonsPerSide) return;

    this.room.send("fire", { side });
  }

  private sendInput(deltaMs: number) {
    this.sendAccumulatorMs += deltaMs;
    const changed =
      this.shipInput.throttle !== this.lastSentInput.throttle ||
      this.shipInput.turn !== this.lastSentInput.turn;

    if (changed || this.sendAccumulatorMs >= INPUT_SEND_INTERVAL_MS) {
      this.room.send("input", this.shipInput);
      this.lastSentInput = { ...this.shipInput };
      this.sendAccumulatorMs = 0;
    }
  }

  private advanceLocalPrediction(dt: number) {
    if (!this.predicted) return;

    const localShip = this.shipSchemas.get(this.room.sessionId);

    // While sunk the server stops moving this ship; freeze prediction too so
    // the sink tween owns rotation/alpha without this loop fighting it.
    if (localShip?.sunk) {
      if (this.serverLocal) this.predicted = { ...this.serverLocal };
      return;
    }

    // Per-ship maxSpeed/turnRate (class + upgrades) instead of the Phase 1-3
    // global constants, so prediction matches this ship's actual stats.
    this.predicted = stepShip(this.predicted, this.shipInput, dt, {
      maxSpeed: localShip.maxSpeed,
      acceleration: ACCELERATION,
      drag: DRAG,
      turnRate: localShip.turnRate,
      turnAcceleration: TURN_ACCELERATION,
      reverseSpeedFactor: REVERSE_SPEED_FACTOR,
    });

    // Soft-correct toward the authoritative server state instead of
    // snapping every tick, so ordinary network jitter stays invisible;
    // only a large divergence (e.g. a reconnect) forces a hard snap.
    if (this.serverLocal) {
      const dx = this.serverLocal.x - this.predicted.x;
      const dy = this.serverLocal.y - this.predicted.y;
      const distance = Math.hypot(dx, dy);

      if (distance > SNAP_DISTANCE) {
        this.predicted = { ...this.serverLocal };
      } else {
        this.predicted.x += dx * RECONCILE_LERP;
        this.predicted.y += dy * RECONCILE_LERP;
        this.predicted.heading = lerpAngle(
          this.predicted.heading,
          this.serverLocal.heading,
          RECONCILE_LERP
        );
      }
    }

    const node = this.shipVisuals.get(this.room.sessionId);
    if (node) {
      const root = shipRoot(node);
      root.setPosition(this.predicted.x, this.predicted.y);
      root.setRotation(this.predicted.heading + SHIP_FACING_OFFSET);
    }
  }

  // Phase 7 (fifth/final slice), still true with real sprites: a purchased
  // hull color cosmetic overrides the normal local/remote tint; "none" (the
  // default for every ship until a purchase) falls straight through to the
  // exact Phase 1-7.4 coloring below, just applied via setTint() on the
  // hull Image now instead of a Graphics fillStyle. Bots/boss are NPCs and
  // never call this — they use the pack's pre-colored complete ship
  // sprites untinted (see npcShipFrame), except the boss's own distinct
  // dark-purple wash (BOSS_SHIP_COLOR, applied directly in createShipNode).
  private hullTintFor(ship: any, isLocal: boolean): number {
    const hullOption = HULL_COLOR_OPTIONS[ship.cosmeticHullColor as string];
    if (hullOption?.color) return Phaser.Display.Color.HexStringToColor(hullOption.color).color;
    return isLocal ? LOCAL_SHIP_COLOR : REMOTE_SHIP_COLOR;
  }

  // Deterministic per-sessionId pick from the pirate/merchant/boss sprite
  // pools (see PIRATE_SHIP_FRAMES/MERCHANT_SHIP_FRAMES above) — a bot's
  // sprite never changes across its lifetime since it's picked once here
  // and the Image is never recreated, only moved (see renderRemoteShips).
  private npcShipFrame(ship: any, sessionId: string): string {
    if (ship.kind === "boss") return BOSS_SHIP_FRAME;
    return pickFrame(ship.kind === "merchant" ? MERCHANT_SHIP_FRAMES : PIRATE_SHIP_FRAMES, sessionId);
  }

  // Builds the retained-mode visual for one ship: a tintable hull+sail+flag
  // Container for a real player, or a single pre-colored Image for a bot/
  // boss. Called once from ships.onAdd (see attachRoom) — never per frame.
  private createShipNode(ship: any, isLocal: boolean, isBoss: boolean, sessionId: string): ShipNode {
    if (ship.kind === "player") {
      const cfg = SHIP_CLASS_VISUALS[ship.shipClass as string] ?? DEFAULT_SHIP_VISUAL;
      const hull = this.add.image(0, 0, SHIP_ATLAS_KEY, cfg.hullFrame);
      const sail = this.add.image(0, -18, SHIP_ATLAS_KEY, cfg.sailFrame);
      const flag = this.add.image(0, -64, SHIP_ATLAS_KEY, "flag (1).png").setVisible(false);
      const container = this.add.container(ship.x, ship.y, [hull, sail, flag]).setScale(cfg.scale).setDepth(0);
      const node: PlayerShipNode = { kind: "player", container, hull, sail, flag };
      this.refreshPlayerShipVisual(node, ship, isLocal);
      return node;
    }

    // Bots/boss: "no per-player tinting needed, these are NPCs" — the
    // chosen complete ship sprite already carries its own sail color and
    // flag emblem (skull for pirates, blank/cross for merchants).
    const image = this.add.image(ship.x, ship.y, SHIP_ATLAS_KEY, this.npcShipFrame(ship, sessionId)).setDepth(0);
    if (isBoss) image.setScale(1.8).setTint(BOSS_SHIP_COLOR);
    return { kind: "npc", image };
  }

  // Re-applies hull/sail/flag tint from the live schema — called once at
  // creation and again on every ship.onChange, same "just recompute, cheap
  // and idempotent" discipline the old triangle.setFillStyle call used.
  private refreshPlayerShipVisual(node: PlayerShipNode, ship: any, isLocal: boolean) {
    node.hull.setTint(this.hullTintFor(ship, isLocal));

    const sailOption = SAIL_PATTERN_OPTIONS[ship.cosmeticSailPattern as string];
    if (sailOption?.color) {
      node.sail.setTint(Phaser.Display.Color.HexStringToColor(sailOption.color).color);
    } else {
      node.sail.clearTint();
    }

    // Clan identity takes priority over a personal flag cosmetic (the two
    // never overlap, same rule renderNameAndClanLabels used to enforce on
    // the drawn banner); a clan's two-tone flag_color_1/2 banner simplifies
    // to clan_color_1 alone since a single sprite only carries one tint.
    if (ship.clanTag && ship.clanColor1) {
      node.flag.setTint(Phaser.Display.Color.HexStringToColor(ship.clanColor1).color).setVisible(true);
      return;
    }
    const flagOption = FLAG_COLOR_OPTIONS[ship.cosmeticFlagColor as string];
    if (flagOption?.color) {
      node.flag.setTint(Phaser.Display.Color.HexStringToColor(flagOption.color).color).setVisible(true);
    } else {
      node.flag.setVisible(false);
    }
  }

  private destroyShipNode(node: ShipNode) {
    if (node.kind === "player") node.container.destroy();
    else node.image.destroy();
  }

  private renderRemoteShips() {
    const renderTime = Date.now() - INTERP_DELAY_MS;

    for (const [sessionId, buffer] of this.remoteBuffers) {
      if (buffer.length === 0) continue;
      if (this.shipSchemas.get(sessionId)?.sunk) continue;

      while (buffer.length > 2 && buffer[1].t <= renderTime) {
        buffer.shift();
      }

      let renderState: ShipPhysicsState;
      if (buffer.length === 1) {
        renderState = buffer[0].state;
      } else {
        const [a, b] = buffer;
        const span = b.t - a.t;
        const t = span <= 0 ? 1 : Phaser.Math.Clamp((renderTime - a.t) / span, 0, 1);
        renderState = {
          x: lerp(a.state.x, b.state.x, t),
          y: lerp(a.state.y, b.state.y, t),
          heading: lerpAngle(a.state.heading, b.state.heading, t),
          speed: lerp(a.state.speed, b.state.speed, t),
        };
      }

      const node = this.shipVisuals.get(sessionId);
      if (node) {
        const root = shipRoot(node);
        root.setPosition(renderState.x, renderState.y);
        root.setRotation(renderState.heading + SHIP_FACING_OFFSET);
      }
    }
  }

  private renderHealthBars() {
    this.healthBarsGraphics.clear();
    const seenBosses = new Set<string>();

    for (const [sessionId, node] of this.shipVisuals) {
      const triangle = shipRoot(node);
      const ship = this.shipSchemas.get(sessionId);
      if (!ship || ship.sunk || !triangle.visible) continue;

      const isBoss = ship.kind === "boss";
      const ratio = Phaser.Math.Clamp(ship.hull / ship.maxHull, 0, 1);
      // Phase 7 (fourth slice): the boss gets a visibly bigger, labeled
      // health bar — "a boss health bar when one is nearby/visible" per
      // the plan — same bar-drawing shape as every other ship, just
      // bigger, plus a text label showing exact hull numbers.
      const width = isBoss ? BOSS_HEALTH_BAR_WIDTH : HEALTH_BAR_WIDTH;
      const height = isBoss ? BOSS_HEALTH_BAR_HEIGHT : HEALTH_BAR_HEIGHT;
      const offsetY = isBoss ? BOSS_HEALTH_BAR_OFFSET_Y : HEALTH_BAR_OFFSET_Y;
      const x = triangle.x - width / 2;
      const y = triangle.y + offsetY;

      this.healthBarsGraphics.fillStyle(0x15232b, 0.8);
      this.healthBarsGraphics.fillRect(x, y, width, height);
      this.healthBarsGraphics.fillStyle(ratio > 0.3 ? 0x5fd86b : 0xe6584f, 0.9);
      this.healthBarsGraphics.fillRect(x, y, width * ratio, height);

      if (isBoss) {
        seenBosses.add(sessionId);
        let label = this.bossLabels.get(sessionId);
        if (!label) {
          label = this.add
            .text(0, 0, "", { fontFamily: "monospace", fontSize: "12px", color: "#ffd166" })
            .setOrigin(0.5)
            .setDepth(7);
          this.bossLabels.set(sessionId, label);
        }
        label.setPosition(triangle.x, y - 10);
        label.setText(`JEFE — ${Math.ceil(ship.hull)}/${ship.maxHull}`);
        label.setVisible(true);
      }
    }

    for (const [sessionId, label] of this.bossLabels) {
      if (!seenBosses.has(sessionId)) label.setVisible(false);
    }
  }

  private renderCannonballs() {
    for (const visual of this.cannonballVisuals.values()) {
      visual.sprite.setPosition(visual.ball.x, visual.ball.y);

      visual.trail.clear();
      for (let i = 0; i < visual.history.length - 1; i++) {
        const point = visual.history[i];
        const alpha = ((i + 1) / visual.history.length) * 0.5;
        visual.trail.fillStyle(0xd9e8ef, alpha);
        visual.trail.fillCircle(point.x, point.y, 2);
      }
    }
  }

  private renderLoot(time: number) {
    for (const visual of this.lootVisuals.values()) {
      visual.marker.y = visual.baseY + Math.sin(time * LOOT_BOB_SPEED) * LOOT_BOB_AMPLITUDE;
    }
  }

  private renderHud() {
    const ship = this.shipSchemas.get(this.room?.sessionId);
    if (!ship) return;

    const safeZoneLine = isInSafeZone(ship.x, ship.y) ? "\nSAFE ZONE" : "";
    const noviceLine = isNoviceProtected(ship.createdAtMs) ? "\nNOVICE PROTECTION" : "";
    const wantedLine = isPirateFlagged(ship.pirateFlagUntilMs) ? `\nWANTED — bounty ${ship.bounty}g` : "";
    const clanLine = ship.clanTag ? `\nClan: [${ship.clanTag}]` : "";
    const regionLine = this.currentRegionId ? `\nRegion ${this.currentRegionId} · Canal ${this.currentChannel}` : "";
    this.hudText.setText(
      `Hull: ${Math.ceil(ship.hull)}/${ship.maxHull}\nGold: ${ship.gold}\nAmmo: ${ship.ammo}/${ship.maxAmmo}\nHonor: ${ship.honor}${clanLine}${regionLine}${safeZoneLine}${noviceLine}${wantedLine}`
    );

    this.reloadBarsGraphics.clear();
    const barWidth = 80;
    const barHeight = 8;
    const centerX = this.scale.width / 2;
    const baseY = this.scale.height - 36;

    const portRatio = 1 - Phaser.Math.Clamp(ship.portReloadRemaining / ship.reloadSeconds, 0, 1);
    const starRatio = 1 - Phaser.Math.Clamp(ship.starboardReloadRemaining / ship.reloadSeconds, 0, 1);

    this.drawReloadBar(centerX - barWidth - 8, baseY, barWidth, barHeight, portRatio);
    this.drawReloadBar(centerX + 8, baseY, barWidth, barHeight, starRatio);
  }

  private drawReloadBar(x: number, y: number, width: number, height: number, ratio: number) {
    this.reloadBarsGraphics.fillStyle(0x0c1820, 0.85);
    this.reloadBarsGraphics.fillRect(x, y, width, height);
    this.reloadBarsGraphics.fillStyle(ratio >= 1 ? 0x4fd8ff : 0x6b7d85, 0.9);
    this.reloadBarsGraphics.fillRect(x, y, width * ratio, height);
  }

  // ---------------------------------------------------------------------
  // Minimap: top-right corner, fixed size, setScrollFactor(0) — see the
  // MINIMAP_* constants' comment near the top of this file. Reads only
  // data the client already has (region geometry from shared/src/world.ts,
  // the synced ship schemas, and the already-computed group/clan state) —
  // nothing new is fetched or synced for this.
  // ---------------------------------------------------------------------

  // World (region-local) coordinates -> minimap panel coordinates. The
  // panel's origin is recomputed from this.scale every call (cheap) so it
  // stays correctly anchored to the top-right corner across resizes, same
  // as centerX/baseY in renderHud above.
  private minimapOrigin(): { panelX: number; panelY: number; mapX: number; mapY: number } {
    const panelX = this.scale.width - MINIMAP_MARGIN - MINIMAP_SIZE;
    const panelY = MINIMAP_MARGIN;
    return { panelX, panelY, mapX: panelX + MINIMAP_PADDING, mapY: panelY + MINIMAP_PADDING };
  }

  private worldToMinimap(x: number, y: number, mapX: number, mapY: number): { x: number; y: number } {
    return {
      x: Phaser.Math.Clamp(mapX + x * MINIMAP_SCALE_X, mapX, mapX + MINIMAP_MAP_SIZE),
      y: Phaser.Math.Clamp(mapY + y * MINIMAP_SCALE_Y, mapY, mapY + MINIMAP_MAP_SIZE),
    };
  }

  private renderMinimap() {
    const g = this.minimapGraphics;
    g.clear();

    const ship = this.shipSchemas.get(this.room?.sessionId);
    if (!ship) return;

    const region = getRegion(this.currentRegionId);
    const { panelX, panelY, mapX, mapY } = this.minimapOrigin();

    // Panel background + border.
    g.fillStyle(MINIMAP_BG_COLOR, 0.72);
    g.fillRect(panelX, panelY, MINIMAP_SIZE, MINIMAP_SIZE);
    g.lineStyle(1, MINIMAP_BORDER_COLOR, 0.9);
    g.strokeRect(panelX, panelY, MINIMAP_SIZE, MINIMAP_SIZE);

    // Safe-zone ring around the dock, same DOCK.safeRadius the main view's
    // own safe-zone circle uses (createWorldGeometry) — not recomputed.
    const dockPos = this.worldToMinimap(DOCK.x, DOCK.y, mapX, mapY);
    g.lineStyle(1, MINIMAP_SAFE_ZONE_COLOR, 0.5);
    g.strokeCircle(dockPos.x, dockPos.y, DOCK.safeRadius * Math.min(MINIMAP_SCALE_X, MINIMAP_SCALE_Y));

    // Islands/rocks, from the exact same region geometry driving the
    // main-view sprites (createWorldGeometry/region.islands/region.rocks).
    g.fillStyle(MINIMAP_ISLAND_COLOR, 0.9);
    for (const island of region.islands) {
      const p = this.worldToMinimap(island.x, island.y, mapX, mapY);
      g.fillCircle(p.x, p.y, 3);
    }
    g.fillStyle(MINIMAP_ROCK_COLOR, 0.9);
    for (const rock of region.rocks) {
      const p = this.worldToMinimap(rock.x, rock.y, mapX, mapY);
      g.fillCircle(p.x, p.y, 2);
    }

    // Dock marker — distinct diamond shape, always shown.
    g.fillStyle(MINIMAP_DOCK_COLOR, 1);
    g.fillRect(dockPos.x - 3, dockPos.y - 3, 6, 6);

    // Allies (group members and clan members) vs. other players ("enemies",
    // range-limited). Reuses the exact same membership data the main view
    // already uses for its own ally highlight (renderNameAndClanLabels'
    // group-name-set) plus the player's own clan tag — no separate
    // membership computation is introduced.
    const myGroupMemberNames = new Set(this.groupState.members.map((m) => m.name));
    const myClanTag = this.clanState.clan?.tag ?? null;
    const localSessionId = this.room?.sessionId;

    for (const [sessionId, node] of this.shipVisuals) {
      if (sessionId === localSessionId) continue;
      const otherShip = this.shipSchemas.get(sessionId);
      if (!otherShip || otherShip.kind !== "player" || otherShip.sunk) continue;

      const root = shipRoot(node);
      if (!root.visible) continue;

      const isAlly =
        (!!otherShip.displayName && myGroupMemberNames.has(otherShip.displayName)) ||
        (!!myClanTag && otherShip.clanTag === myClanTag);

      if (!isAlly) {
        const distance = Math.hypot(root.x - ship.x, root.y - ship.y);
        if (distance > MINIMAP_ENEMY_RADIUS) continue;
      }

      const p = this.worldToMinimap(root.x, root.y, mapX, mapY);
      g.fillStyle(isAlly ? MINIMAP_ALLY_COLOR : MINIMAP_ENEMY_COLOR, 0.95);
      g.fillCircle(p.x, p.y, isAlly ? 3 : 2.5);
    }

    // Local player — brightest marker, plus a short heading tick (heading
    // 0 = facing +X, same convention SHIP_FACING_OFFSET/stepShip use).
    const localPos = this.worldToMinimap(ship.x, ship.y, mapX, mapY);
    const heading = this.predicted?.heading ?? ship.heading;
    g.fillStyle(MINIMAP_LOCAL_COLOR, 1);
    g.fillCircle(localPos.x, localPos.y, 4);
    g.lineStyle(2, MINIMAP_LOCAL_COLOR, 1);
    g.lineBetween(
      localPos.x,
      localPos.y,
      localPos.x + Math.cos(heading) * 8,
      localPos.y + Math.sin(heading) * 8
    );

    // Region-border hints: a glow along whichever panel edge(s) correspond
    // to a direction this region actually has a neighbor in (Phase 7
    // multi-region grid) — reuses region.neighbors directly, same
    // adjacency RegionDef/detectBorderCrossing already compute server- and
    // client-side; no new adjacency logic here.
    g.lineStyle(3, MINIMAP_BORDER_HINT_COLOR, 0.65);
    if (region.neighbors.north) g.lineBetween(panelX + 4, panelY + 1, panelX + MINIMAP_SIZE - 4, panelY + 1);
    if (region.neighbors.south)
      g.lineBetween(panelX + 4, panelY + MINIMAP_SIZE - 1, panelX + MINIMAP_SIZE - 4, panelY + MINIMAP_SIZE - 1);
    if (region.neighbors.west) g.lineBetween(panelX + 1, panelY + 4, panelX + 1, panelY + MINIMAP_SIZE - 4);
    if (region.neighbors.east)
      g.lineBetween(panelX + MINIMAP_SIZE - 1, panelY + 4, panelX + MINIMAP_SIZE - 1, panelY + MINIMAP_SIZE - 4);
  }

  private spawnMuzzleFlash(x: number, y: number) {
    const flash = this.add.image(x, y, "fx-fire1").setDepth(6).setScale(0.6).setAlpha(0.95);
    this.tweens.add({
      targets: flash,
      scale: 1.1,
      alpha: 0,
      duration: 150,
      onComplete: () => flash.destroy(),
    });
  }

  // A small explosion puff at the point of impact — distinct from the
  // floating damage number (spawnDamageNumber), which stays as-is.
  private spawnHitFlash(x: number, y: number) {
    const flash = this.add.image(x, y, "fx-explosion3").setDepth(6).setScale(0.5).setAlpha(0.95);
    this.tweens.add({
      targets: flash,
      scale: 0.9,
      alpha: 0,
      duration: 250,
      onComplete: () => flash.destroy(),
    });
  }

  private spawnSplashPuff(x: number, y: number) {
    const puff = this.add.circle(x, y, 4, 0xcfe9f0, 0.7).setDepth(4);
    this.tweens.add({
      targets: puff,
      radius: 16,
      alpha: 0,
      duration: 400,
      onComplete: () => puff.destroy(),
    });
  }

  private spawnLootPop(x: number, y: number) {
    const sparkle = this.add.circle(x, y, 8, 0xfff6cc, 0.9).setDepth(6);
    this.tweens.add({
      targets: sparkle,
      radius: 20,
      alpha: 0,
      duration: 300,
      onComplete: () => sparkle.destroy(),
    });
  }

  private spawnDamageNumber(x: number, y: number, damage: number) {
    const text = this.add
      .text(x, y, `-${damage}`, { fontFamily: "monospace", fontSize: "14px", color: "#ff7a6b" })
      .setDepth(7)
      .setOrigin(0.5);

    this.tweens.add({
      targets: text,
      y: y - 30,
      alpha: 0,
      duration: 800,
      onComplete: () => text.destroy(),
    });
  }

  private playSinkAnimation(sessionId: string) {
    const node = this.shipVisuals.get(sessionId);
    if (!node) return;
    const root = shipRoot(node);

    const burst = this.add.image(root.x, root.y, "fx-explosion1").setDepth(6).setScale(0.4).setAlpha(0.9);
    this.tweens.add({
      targets: burst,
      scale: 1,
      alpha: 0,
      duration: SINK_ANIM_MS * 0.6,
      onComplete: () => burst.destroy(),
    });

    this.tweens.add({
      targets: root,
      angle: root.angle + 70,
      alpha: 0,
      duration: SINK_ANIM_MS,
      onComplete: () => root.setVisible(false),
    });
  }

  private playRespawnFadeIn(sessionId: string) {
    const node = this.shipVisuals.get(sessionId);
    if (!node) return;
    const root = shipRoot(node);

    root.setAngle(0);
    root.setAlpha(0);
    root.setVisible(true);
    this.tweens.add({ targets: root, alpha: 1, duration: RESPAWN_FADE_MS });
  }

  // ---------------------------------------------------------------------
  // Phase 4: dock UI (Astillero / Reparación / Mercado / Armería / Mejoras)
  // ---------------------------------------------------------------------

  private createDockUI() {
    const backdrop = document.createElement("div");
    backdrop.id = "dock-backdrop";
    backdrop.classList.add("hidden");

    const panel = document.createElement("div");
    panel.id = "dock-panel";
    panel.innerHTML = `
      <button type="button" class="dock-close" aria-label="Cerrar">×</button>
      <div class="dock-tabs">
        <button data-tab="shipyard" class="active">Astillero</button>
        <button data-tab="repair">Reparar</button>
        <button data-tab="market">Mercado</button>
        <button data-tab="armory">Armería</button>
        <button data-tab="upgrades">Mejoras</button>
        <button data-tab="cosmetics">Apariencia</button>
        <button data-tab="tavern">Taberna</button>
      </div>
      <div class="dock-body"></div>
    `;
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    this.dockPanelEl = panel;
    this.dockBackdropEl = backdrop;

    // Single close path reused by the close button, the backdrop click and
    // Escape — all of them just flip the same state the B keybinding and
    // the "leave the safe zone" auto-close already use.
    panel.querySelector<HTMLButtonElement>(".dock-close")!.addEventListener("click", () => {
      this.dockOpen = false;
    });
    backdrop.addEventListener("click", (ev) => {
      if (ev.target === backdrop) this.dockOpen = false;
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && this.dockOpen) this.dockOpen = false;
    });

    panel.querySelectorAll<HTMLButtonElement>(".dock-tabs button").forEach((btn) => {
      btn.addEventListener("click", () => {
        panel.querySelectorAll(".dock-tabs button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        this.activeDockTab = btn.dataset.tab as DockTab;
        if (this.activeDockTab === "market") {
          this.room.send("dock:listPrices");
          this.room.send("market:listListings");
        }
        this.renderDockTab();
      });
    });

    const hint = document.createElement("div");
    hint.id = "dock-hint";
    hint.classList.add("hidden");
    hint.textContent = "Docked — press B for the shipyard";
    document.body.appendChild(hint);
    this.dockHintEl = hint;
  }

  // Dock access is gated purely by the existing isInSafeZone check — no
  // separate "is docked" concept is introduced.
  private updateDockVisibility(deltaMs: number) {
    const ship = this.shipSchemas.get(this.room?.sessionId);
    const docked = !!ship && !ship.sunk && isInSafeZone(ship.x, ship.y);

    if (!this.chatInputFocused && Phaser.Input.Keyboard.JustDown(this.keyB) && docked) {
      this.dockOpen = !this.dockOpen;
      if (this.dockOpen) {
        this.room.send("dock:listShips");
        this.room.send("tavern:open");
        this.tavernRefreshAccumulatorMs = 0;
        this.renderDockTab();
      }
    }

    if (!docked && this.dockOpen) this.dockOpen = false;

    this.dockHintEl.classList.toggle("hidden", !docked || this.dockOpen);
    this.dockBackdropEl.classList.toggle("hidden", !this.dockOpen);
    this.tickTavernRefresh(deltaMs);
  }

  // Phase 5: while the Tavern tab is the active one and the panel is open,
  // poll lightly (tavern:refresh — doesn't touch the mission board) so
  // progress/streak/weekly/achievements stay close to live without a new
  // real-time push layer; the mission board itself only regenerates on an
  // explicit open/accept.
  private tickTavernRefresh(deltaMs: number) {
    if (!this.dockOpen || this.activeDockTab !== "tavern") {
      this.tavernRefreshAccumulatorMs = 0;
      return;
    }

    this.tavernRefreshAccumulatorMs += deltaMs;
    if (this.tavernRefreshAccumulatorMs >= TAVERN_REFRESH_INTERVAL_MS) {
      this.tavernRefreshAccumulatorMs = 0;
      this.room.send("tavern:refresh");
    }
  }

  private renderDockTab() {
    const ship = this.shipSchemas.get(this.room?.sessionId);
    const body = this.dockPanelEl.querySelector<HTMLDivElement>(".dock-body");
    if (!ship || !body) return;

    switch (this.activeDockTab) {
      case "shipyard":
        return this.renderShipyardTab(body, ship);
      case "repair":
        return this.renderRepairTab(body, ship);
      case "market":
        return this.renderMarketTab(body, ship);
      case "armory":
        return this.renderArmoryTab(body, ship);
      case "upgrades":
        return this.renderUpgradesTab(body, ship);
      case "cosmetics":
        return this.renderCosmeticsTab(body, ship);
      case "tavern":
        return this.renderTavernTab(body);
    }
  }

  // Phase 6: a short honor-gated banner, reused by every tab that charges
  // gold — the server enforces the actual multiplier/refusal (see
  // db/dock.ts), this just keeps the displayed numbers truthful.
  private honorPricingNotice(ship: any): string {
    if (isDockServiceRefused(ship.honor)) {
      return `<p><small>⚠ The dock refuses service — your reputation (honor ${ship.honor}) is too low.</small></p>`;
    }
    const mult = honorPriceMultiplier(ship.honor);
    if (mult < 1) return `<p><small>Good reputation discount applied (honor ${ship.honor}): ${Math.round((1 - mult) * 100)}% off.</small></p>`;
    if (mult > 1) return `<p><small>Poor reputation surcharge applied (honor ${ship.honor}): +${Math.round((mult - 1) * 100)}%.</small></p>`;
    return "";
  }

  private renderShipyardTab(body: HTMLDivElement, ship: any) {
    const gold: number = ship.gold;
    const refused = isDockServiceRefused(ship.honor);
    const mult = honorPriceMultiplier(ship.honor);

    const classRows = Object.values(SHIP_CLASSES)
      .filter((c) => c.key !== "bot-default")
      .map((c) => {
        const price = Math.max(1, Math.round(c.price * mult));
        return `
        <div class="dock-row">
          <span>${c.name} — ${price}g<br/>
            <small>Hull ${c.maxHull} · Spd ${c.maxSpeed} · Turn ${c.turnRate.toFixed(2)} · Cannons ${c.cannonsPerSide} · Bodega ${c.cargoCapacity}</small>
          </span>
          <button class="dock-action" data-buy="${c.key}" ${refused || gold < price ? "disabled" : ""}>Buy</button>
        </div>`;
      })
      .join("");

    const ownedRows = this.ownedShips
      .map((s) => {
        const classDef = SHIP_CLASSES[s.classKey as ShipClassKey];
        return `
        <div class="dock-row">
          <span>${classDef?.name ?? s.classKey} (hull ${Math.ceil(s.hull)})${s.isActive ? " — active" : ""}</span>
          <button class="dock-action" data-switch="${s.id}" ${s.isActive ? "disabled" : ""}>Use</button>
        </div>`;
      })
      .join("");

    body.innerHTML = `
      <strong>Gold: ${gold}</strong>
      ${this.honorPricingNotice(ship)}
      <div>${classRows}</div>
      <strong>Your ships</strong>
      <div>${ownedRows || "<em>loading…</em>"}</div>
    `;

    body.querySelectorAll<HTMLButtonElement>("[data-buy]").forEach((btn) => {
      btn.addEventListener("click", () => this.room.send("dock:buyShip", { classKey: btn.dataset.buy }));
    });
    body.querySelectorAll<HTMLButtonElement>("[data-switch]").forEach((btn) => {
      btn.addEventListener("click", () => this.room.send("dock:switchShip", { shipId: btn.dataset.switch }));
    });
  }

  private renderRepairTab(body: HTMLDivElement, ship: any) {
    const refused = isDockServiceRefused(ship.honor);
    const missing = Math.max(0, ship.maxHull - ship.hull);
    const cost = Math.max(1, Math.ceil(missing * REPAIR_COST_PER_HULL * honorPriceMultiplier(ship.honor)));

    body.innerHTML = `
      ${this.honorPricingNotice(ship)}
      <div class="dock-row"><span>Hull</span><span>${Math.ceil(ship.hull)} / ${ship.maxHull}</span></div>
      <div class="dock-row"><span>Repair cost</span><span>${missing > 0 ? cost + "g" : "full"}</span></div>
      <button class="dock-action" id="repair-btn" ${refused || missing <= 0 || ship.gold < cost ? "disabled" : ""}>Repair</button>
    `;
    body.querySelector("#repair-btn")!.addEventListener("click", () => this.room.send("dock:repair"));
  }

  // Phase 7 (second slice): real commodity trading, finally giving this
  // tab something to do — Phase 4's version was deliberately thin because
  // there was nothing to trade yet (see dock_prices / ships.cargo).
  private renderMarketTab(body: HTMLDivElement, ship: any) {
    const used = ship.cargoRon + ship.cargoEspecias + ship.cargoSeda + ship.cargoMadera;
    const capacity = ship.cargoCapacity;
    const remaining = capacity - used;

    if (this.dockPrices.length === 0) {
      body.innerHTML = `<p><em>Cargando precios del mercado…</em></p>`;
      this.room.send("dock:listPrices");
      this.room.send("market:listListings");
      return;
    }

    const cargoByCommodity: Record<string, number> = {
      ron: ship.cargoRon,
      especias: ship.cargoEspecias,
      seda: ship.cargoSeda,
      madera: ship.cargoMadera,
    };

    const rows = this.dockPrices
      .map((p) => {
        const def = COMMODITIES[p.commodity];
        const owned = cargoByCommodity[p.commodity] ?? 0;
        const canBuy = remaining > 0 && ship.gold >= p.currentPrice;
        const canSell = owned > 0;
        return `
        <div class="dock-row">
          <span>${def?.name ?? p.commodity}<br/><small>Precio: ${p.currentPrice}g · En bodega: ${owned}</small></span>
          <span>
            <button class="dock-action" data-buy-commodity="${p.commodity}" ${canBuy ? "" : "disabled"}>Comprar</button>
            <button class="dock-action" data-sell-commodity="${p.commodity}" ${canSell ? "" : "disabled"}>Vender</button>
          </span>
        </div>`;
      })
      .join("");

    body.innerHTML = `
      <strong>Gold: ${ship.gold}</strong>
      <div class="dock-row"><span>Bodega</span><span>${used} / ${capacity}</span></div>
      <div>${rows}</div>
      <p><small>Compra/venta de 1 unidad por clic contra el puerto (precios dinámicos NPC).
      El precio sube al comprar y baja al vender en este mismo puerto, y se recupera solo con el tiempo.</small></p>
      <hr/>
      ${this.renderPlayerMarketSection(ship, cargoByCommodity)}
    `;

    body.querySelectorAll<HTMLButtonElement>("[data-buy-commodity]").forEach((btn) => {
      btn.addEventListener("click", () =>
        this.room.send("dock:buyCargo", { commodity: btn.dataset.buyCommodity, quantity: 1 })
      );
    });
    body.querySelectorAll<HTMLButtonElement>("[data-sell-commodity]").forEach((btn) => {
      btn.addEventListener("click", () =>
        this.room.send("dock:sellCargo", { commodity: btn.dataset.sellCommodity, quantity: 1 })
      );
    });

    this.wirePlayerMarketSection(body);
  }

  // Phase 7 (fifth/final slice): player-to-player listings at this exact
  // dock — a genuinely separate sub-section from the NPC trade rows above
  // (different table, different gold flow: a 5% commission sink instead
  // of a price-shift curve). Scoped per-dock (this.regionId), not global —
  // see server/src/db/market.ts's comment on why.
  private renderPlayerMarketSection(ship: any, cargoByCommodity: Record<string, number>): string {
    const sellableCommodities = COMMODITY_KEYS.filter((k) => (cargoByCommodity[k] ?? 0) > 0);
    const listingForm =
      sellableCommodities.length > 0
        ? `
      <div class="dock-row">
        <span>
          <select id="listing-commodity">
            ${sellableCommodities
              .map((k) => `<option value="${k}">${COMMODITIES[k].name} (tienes ${cargoByCommodity[k]})</option>`)
              .join("")}
          </select>
          Cant. <input id="listing-quantity" type="number" min="1" value="1" style="width:48px" />
          Precio/u <input id="listing-price" type="number" min="1" value="${COMMODITIES[sellableCommodities[0]].basePrice}" style="width:64px" />
        </span>
        <button class="dock-action" id="create-listing-btn">Publicar</button>
      </div>`
        : `<p><small>No tienes mercancía en la bodega para publicar aquí.</small></p>`;

    const listingRows = this.marketListings
      .map((l) => {
        const def = COMMODITIES[l.commodity];
        const totalIfAll = l.pricePerUnit * l.quantity;
        if (l.isMine) {
          return `
          <div class="dock-row">
            <span>${def?.name ?? l.commodity} x${l.quantity} @ ${l.pricePerUnit}g <em>(tu publicación)</em><br/>
              <small>Total si se vende todo: ${totalIfAll}g</small></span>
            <button class="dock-action" data-cancel-listing="${l.id}">Cancelar</button>
          </div>`;
        }
        return `
        <div class="dock-row">
          <span>${def?.name ?? l.commodity} x${l.quantity} @ ${l.pricePerUnit}g — vende ${l.sellerDisplayName}</span>
          <span>
            <input type="number" min="1" max="${l.quantity}" value="1" data-buy-quantity="${l.id}" style="width:48px" />
            <button class="dock-action" data-buy-listing="${l.id}" ${ship.gold < l.pricePerUnit ? "disabled" : ""}>Comprar</button>
          </span>
        </div>`;
      })
      .join("");

    return `
      <strong>Mercado de jugadores (este puerto)</strong>
      ${listingForm}
      <div>${listingRows || "<p><small>No hay publicaciones activas en este puerto.</small></p>"}</div>
      <p><small>Comisión del mercado: ${Math.round(MARKET_COMMISSION_RATE * 100)}% sobre cada venta — no se
      acredita a nadie, es un sumidero de oro deliberado.</small></p>
    `;
  }

  private wirePlayerMarketSection(body: HTMLDivElement) {
    body.querySelector<HTMLButtonElement>("#create-listing-btn")?.addEventListener("click", () => {
      const commodity = body.querySelector<HTMLSelectElement>("#listing-commodity")?.value;
      const quantity = Number(body.querySelector<HTMLInputElement>("#listing-quantity")?.value);
      const pricePerUnit = Number(body.querySelector<HTMLInputElement>("#listing-price")?.value);
      this.room.send("market:createListing", { commodity, quantity, pricePerUnit });
    });

    body.querySelectorAll<HTMLButtonElement>("[data-cancel-listing]").forEach((btn) => {
      btn.addEventListener("click", () =>
        this.room.send("market:cancelListing", { listingId: btn.dataset.cancelListing })
      );
    });

    body.querySelectorAll<HTMLButtonElement>("[data-buy-listing]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const listingId = btn.dataset.buyListing!;
        const qtyInput = body.querySelector<HTMLInputElement>(`[data-buy-quantity="${listingId}"]`);
        const quantity = Number(qtyInput?.value ?? 1);
        this.room.send("market:buyListing", { listingId, quantity });
      });
    });
  }

  // Phase 7 (fifth/final slice): cosmetics shop. Reads straight from the
  // shared COSMETIC_CATALOG (pure data) for every option's name/cost/
  // color, same "client renders from shared defs, server just validates
  // and debits" convention as the Shipyard/Armory/Upgrades tabs above —
  // no cosmetics:list round-trip needed.
  private renderCosmeticsTab(body: HTMLDivElement, ship: any) {
    const currentBySlot: Record<CosmeticSlot, string> = {
      hullColor: ship.cosmeticHullColor,
      sailPattern: ship.cosmeticSailPattern,
      flagColor: ship.cosmeticFlagColor,
      wakeColor: ship.cosmeticWakeColor,
    };

    const sections = COSMETIC_SLOTS.map((slot) => {
      const current = currentBySlot[slot];
      const rows = Object.values(COSMETIC_CATALOG[slot])
        .filter((opt) => opt.key !== COSMETIC_NONE_KEY)
        .map((opt) => {
          const owned = opt.key === current;
          const disabled = owned || ship.gold < opt.cost;
          const swatch = opt.color
            ? `<span style="display:inline-block;width:10px;height:10px;margin-right:4px;border:1px solid #15232b;background:${opt.color}"></span>`
            : "";
          return `
          <div class="dock-row">
            <span>${swatch}${opt.name} — ${opt.cost}g${owned ? " <em>(actual)</em>" : ""}</span>
            <button class="dock-action" data-cosmetic-slot="${slot}" data-cosmetic-key="${opt.key}" ${disabled ? "disabled" : ""}>Comprar</button>
          </div>`;
        })
        .join("");
      return `<strong>${COSMETIC_SLOT_LABELS[slot]}</strong><div>${rows}</div>`;
    }).join("");

    body.innerHTML = `
      <strong>Gold: ${ship.gold}</strong>
      <p><small>Puramente cosmético: ninguna de estas compras cambia estadísticas de combate
      o navegación. Comprar una nueva opción reemplaza la que tengas puesta en esa categoría.</small></p>
      ${sections}
    `;

    body.querySelectorAll<HTMLButtonElement>("[data-cosmetic-slot]").forEach((btn) => {
      btn.addEventListener("click", () =>
        this.room.send("cosmetics:buy", { slot: btn.dataset.cosmeticSlot, key: btn.dataset.cosmeticKey })
      );
    });
  }

  private renderArmoryTab(body: HTMLDivElement, ship: any) {
    const refused = isDockServiceRefused(ship.honor);
    const missing = Math.max(0, ship.maxAmmo - ship.ammo);
    const cost = Math.max(1, Math.ceil(missing * AMMO_COST_PER_UNIT * honorPriceMultiplier(ship.honor)));

    body.innerHTML = `
      ${this.honorPricingNotice(ship)}
      <div class="dock-row"><span>Ammo</span><span>${ship.ammo} / ${ship.maxAmmo}</span></div>
      <div class="dock-row"><span>Resupply cost</span><span>${missing > 0 ? cost + "g" : "full"}</span></div>
      <button class="dock-action" id="ammo-btn" ${refused || missing <= 0 || ship.gold < cost ? "disabled" : ""}>Resupply</button>
    `;
    body.querySelector("#ammo-btn")!.addEventListener("click", () => this.room.send("dock:buyAmmo"));
  }

  private renderUpgradesTab(body: HTMLDivElement, ship: any) {
    const refused = isDockServiceRefused(ship.honor);
    const mult = honorPriceMultiplier(ship.honor);
    const classKey = ship.shipClass as ShipClassKey;
    const caps = UPGRADE_CAPS_BY_CLASS[classKey];
    const levels: Record<UpgradeKey, number> = {
      hull: ship.upgradeHull,
      sails: ship.upgradeSails,
      helm: ship.upgradeHelm,
      cannons: ship.upgradeCannons,
      gunPorts: ship.upgradeGunPorts,
      gunners: ship.upgradeGunners,
      bodega: ship.upgradeBodega,
    };

    const rows = (Object.keys(UPGRADE_DEFS) as UpgradeKey[])
      .map((key) => {
        const def = UPGRADE_DEFS[key];
        const level = levels[key];
        const cap = caps[key];
        const atCap = level >= cap;
        const cost = atCap ? null : Math.max(1, Math.round(costForUpgradeLevel(def, level + 1) * mult));
        const disabled = atCap || refused || (cost !== null && ship.gold < cost);

        return `
        <div class="dock-row">
          <span>${def.name}<br/><small>Lv ${level}/${cap}</small></span>
          <button class="dock-action" data-upgrade="${key}" ${disabled ? "disabled" : ""}>
            ${atCap ? "MAX" : `${cost}g`}
          </button>
        </div>`;
      })
      .join("");

    body.innerHTML = `<strong>Gold: ${ship.gold}</strong>${this.honorPricingNotice(ship)}<div>${rows}</div>`;

    body.querySelectorAll<HTMLButtonElement>("[data-upgrade]").forEach((btn) => {
      btn.addEventListener("click", () => this.room.send("dock:buyUpgrade", { key: btn.dataset.upgrade }));
    });
  }

  // ---------------------------------------------------------------------
  // Phase 5: Tavern tab (mission board, daily tasks, login streak, weekly
  // challenges, achievements, weekly ranking).
  // ---------------------------------------------------------------------

  private missionTypeLabel(type: string): string {
    if (type === "caza") return "Caza";
    if (type === "escolta") return "Escolta";
    if (type === "exploracion") return "Exploración";
    return type;
  }

  private renderTavernTab(body: HTMLDivElement) {
    const state = this.tavernState;
    if (!state) {
      body.innerHTML = `<p><em>Cargando…</em></p>`;
      return;
    }

    body.innerHTML = `
      <strong>Racha de ingreso: ${state.streak.count} día(s)</strong>
      <small>Cada 7 días consecutivos otorga un cofre de oro extra.</small>
      ${state.title ? `<div class="dock-row"><span>Título</span><span>${state.title}</span></div>` : ""}

      <strong>Tablón de misiones</strong>
      <div id="tavern-offers">${this.renderOfferRows(state.offers)}</div>

      <strong>Misiones activas</strong>
      <div>${this.renderActiveMissionRows(state.missions)}</div>

      <strong>Tareas diarias</strong>
      <div>${this.renderDailyTaskRows(state.dailyTasks, state.rerollAvailable)}</div>

      <strong>Desafíos semanales</strong>
      <div>${this.renderWeeklyChallengeRows(state.weeklyChallenges)}</div>

      <strong>Logros</strong>
      <div>${this.renderAchievementRows(state.achievements)}</div>

      <strong>Ranking semanal</strong>
      <div class="dock-row">
        <button class="dock-action" id="ranking-metric-gold" ${this.rankingMetric === "gold_earned" ? "disabled" : ""}>Oro</button>
        <button class="dock-action" id="ranking-metric-bots" ${this.rankingMetric === "bots_sunk" ? "disabled" : ""}>Barcos hundidos</button>
      </div>
      <div id="tavern-ranking">${this.renderRankingRows()}</div>
    `;

    body.querySelectorAll<HTMLButtonElement>("[data-accept-slot]").forEach((btn) => {
      btn.addEventListener("click", () =>
        this.room.send("tavern:acceptMission", { slot: Number(btn.dataset.acceptSlot) })
      );
    });
    body.querySelectorAll<HTMLButtonElement>("[data-claim-task]").forEach((btn) => {
      btn.addEventListener("click", () =>
        this.room.send("tavern:claimDailyTask", { taskId: btn.dataset.claimTask })
      );
    });
    body.querySelectorAll<HTMLButtonElement>("[data-reroll-task]").forEach((btn) => {
      btn.addEventListener("click", () =>
        this.room.send("tavern:rerollDailyTask", { taskId: btn.dataset.rerollTask })
      );
    });
    body.querySelector("#ranking-metric-gold")?.addEventListener("click", () => this.setRankingMetric("gold_earned"));
    body.querySelector("#ranking-metric-bots")?.addEventListener("click", () => this.setRankingMetric("bots_sunk"));

    if (this.rankingEntries === null && !this.rankingLoading) this.loadRanking();
  }

  private renderOfferRows(offers: TavernState["offers"]): string {
    if (offers.length === 0) return "<em>No hay misiones disponibles ahora mismo.</em>";

    return offers
      .map(
        (offer, index) => `
        <div class="dock-row">
          <span>${offer.title}<br/><small>${offer.description}</small></span>
          <button class="dock-action" data-accept-slot="${index}">${offer.rewardGold}g</button>
        </div>`
      )
      .join("");
  }

  private renderActiveMissionRows(missions: TavernState["missions"]): string {
    if (missions.length === 0) return "<em>Ninguna misión activa.</em>";

    return missions
      .map((mission) => {
        const label = this.missionTypeLabel(mission.mission_type);
        const unit = mission.mission_type === "escolta" ? "s" : "";
        return `
        <div class="dock-row">
          <span>${label}<br/><small>${Math.floor(mission.progress)}/${mission.target}${unit} — recompensa ${mission.reward_gold}g</small></span>
        </div>`;
      })
      .join("");
  }

  private renderDailyTaskRows(tasks: TavernState["dailyTasks"], rerollAvailable: boolean): string {
    if (tasks.length === 0) return "<em>Cargando tareas…</em>";

    return tasks
      .map((task) => {
        const label = DAILY_TASK_LABELS[task.task_type] ?? task.task_type;
        const complete = task.progress >= task.target;
        const claimDisabled = task.claimed || !complete;

        return `
        <div class="dock-row">
          <span>${label}<br/><small>${task.progress}/${task.target} — recompensa ${task.reward_gold}g</small></span>
          <span style="display:flex; gap:4px;">
            <button class="dock-action" data-claim-task="${task.id}" ${claimDisabled ? "disabled" : ""}>
              ${task.claimed ? "Cobrada" : "Cobrar"}
            </button>
            <button class="dock-action" data-reroll-task="${task.id}" ${task.claimed || !rerollAvailable ? "disabled" : ""}>
              Rehacer
            </button>
          </span>
        </div>`;
      })
      .join("");
  }

  private renderWeeklyChallengeRows(challenges: TavernState["weeklyChallenges"]): string {
    return challenges
      .map(
        (c) => `
        <div class="dock-row">
          <span>${c.title}<br/><small>${Math.min(c.progress, c.threshold)}/${c.threshold} — recompensa ${c.rewardGold}g</small></span>
          <span>${c.claimed ? "✓" : ""}</span>
        </div>`
      )
      .join("");
  }

  private renderAchievementRows(achievements: TavernState["achievements"]): string {
    return achievements
      .map(
        (a) => `
        <div class="dock-row ${a.unlocked ? "" : "dock-row-locked"}">
          <span>${a.unlocked ? a.title : `🔒 ${a.title}`}<br/><small>${a.description}</small></span>
          <span><small>${a.rewardGold}g${a.rewardTitle ? ` · "${a.rewardTitle}"` : ""}</small></span>
        </div>`
      )
      .join("");
  }

  private renderRankingRows(): string {
    if (this.rankingLoading) return "<em>Cargando ranking…</em>";
    if (!this.rankingEntries || this.rankingEntries.length === 0) return "<em>Sin datos todavía.</em>";

    return this.rankingEntries
      .map(
        (entry, index) => `
        <div class="dock-row">
          <span>#${index + 1} ${entry.displayName}${entry.title ? ` — ${entry.title}` : ""}</span>
          <span>${entry.value}</span>
        </div>`
      )
      .join("");
  }

  private setRankingMetric(metric: "gold_earned" | "bots_sunk") {
    if (this.rankingMetric === metric) return;
    this.rankingMetric = metric;
    this.rankingEntries = null;
    this.loadRanking();
  }

  private async loadRanking() {
    this.rankingLoading = true;
    if (this.dockOpen && this.activeDockTab === "tavern") this.renderDockTab();

    try {
      const res = await fetchWeeklyRanking(this.rankingMetric);
      this.rankingEntries = res.ranking;
    } catch (err) {
      console.warn("[tavern] failed to load ranking", err);
      this.rankingEntries = [];
    } finally {
      this.rankingLoading = false;
      if (this.dockOpen && this.activeDockTab === "tavern") this.renderDockTab();
    }
  }

  // Phase 5: an unlocked achievement can grant a text title shown next to
  // the player's name. There's no per-ship name-label system in the world
  // view (no Phase 1-4 UI shows any player's name over their ship), so
  // this updates the one place a display name already appears client-side
  // — the account corner — rather than inventing a new label layer.
  private updateAccountCornerTitle() {
    const session = getSession();
    const corner = this.accountCornerEl;
    const title = this.tavernState?.title;
    if (!session || !corner || session.isGuest) return;

    const btn = corner.querySelector("button");
    if (btn) btn.textContent = title ? `${session.displayName} — ${title}` : session.displayName;
  }

  private handleDockResult(payload: { action: string; ok: boolean; reason?: string }) {
    if (!payload.ok) {
      console.warn(`[dock] ${payload.action} failed: ${payload.reason ?? "unknown reason"}`);
    }
    if (!this.dockOpen) return;

    if (payload.action === "buyShip" || payload.action === "switchShip") {
      this.room.send("dock:listShips");
    }
    this.renderDockTab();
  }

  // ---------------------------------------------------------------------
  // Phase 4: guest -> account conversion (always available, not dock-gated)
  // ---------------------------------------------------------------------

  private createAccountUI() {
    const session = getSession();
    if (!session) return;

    const corner = document.createElement("div");
    corner.id = "account-corner";
    this.accountCornerEl = corner;

    if (session.isGuest) {
      corner.innerHTML = `<button id="account-convert-btn" type="button">Save account</button>`;
      document.body.appendChild(corner);
      corner
        .querySelector("#account-convert-btn")!
        .addEventListener("click", () => this.openConvertForm(corner));
    } else {
      corner.innerHTML = `<button disabled>${session.displayName}</button>`;
      document.body.appendChild(corner);
    }
  }

  private openConvertForm(corner: HTMLDivElement) {
    const session = getSession();
    if (!session) return;

    corner.innerHTML = `
      <form id="convert-form" style="display:flex; flex-direction:column; gap:6px; background:#0c1f2bee; border:1px solid #1f3b4a; border-radius:6px; padding:10px; width:200px;">
        <input id="convert-email" type="email" placeholder="email" required style="font-family:monospace; padding:6px;" />
        <input id="convert-password" type="password" placeholder="password (min 8)" minlength="8" required style="font-family:monospace; padding:6px;" />
        <button type="submit">Create account</button>
        <div id="convert-error" style="color:#ff7a6b; font-size:11px;"></div>
      </form>
    `;

    const form = corner.querySelector<HTMLFormElement>("#convert-form")!;
    const errorBox = corner.querySelector<HTMLDivElement>("#convert-error")!;

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const email = (corner.querySelector("#convert-email") as HTMLInputElement).value;
      const password = (corner.querySelector("#convert-password") as HTMLInputElement).value;

      try {
        const res = await upgradeToAccount(session.token, email, password);
        setSession({
          token: res.token,
          playerId: res.player.id,
          displayName: res.player.displayName,
          isGuest: false,
        });
        corner.innerHTML = `<button disabled>${res.player.displayName}</button>`;
      } catch (err) {
        errorBox.textContent = err instanceof Error ? err.message : "failed to save account";
      }
    });
  }

  // ---------------------------------------------------------------------
  // Phase 6: reputation / clan-flag / name-label world overlays. Pirate
  // indicator + bounty are visible to everyone per the plan; the clan
  // tint/flag/tag and a name label are drawn the same way, reusing the
  // ship-mirrored fields OceanRoom already keeps in sync.
  // ---------------------------------------------------------------------

  private renderReputationIndicators() {
    this.reputationGraphics.clear();
    const seen = new Set<string>();

    for (const [sessionId, node] of this.shipVisuals) {
      const triangle = shipRoot(node);
      const ship = this.shipSchemas.get(sessionId);
      if (!ship || ship.kind !== "player" || ship.sunk || !triangle.visible) continue;
      if (!isPirateFlagged(ship.pirateFlagUntilMs)) continue;

      seen.add(sessionId);
      const x = triangle.x;
      const y = triangle.y + HEALTH_BAR_OFFSET_Y - 10;

      this.reputationGraphics.lineStyle(2, 0xff3b3b, 0.95);
      this.reputationGraphics.strokeCircle(x, y, 10);

      let text = this.reputationTexts.get(sessionId);
      if (!text) {
        text = this.add
          .text(0, 0, "", { fontFamily: "monospace", fontSize: "10px", color: "#ff6b5c" })
          .setOrigin(0.5)
          .setDepth(7);
        this.reputationTexts.set(sessionId, text);
      }
      text.setPosition(x, y - 16);
      text.setText(`☠ ${ship.bounty}g`);
      text.setVisible(true);
    }

    for (const [sessionId, text] of this.reputationTexts) {
      if (!seen.has(sessionId)) text.setVisible(false);
    }
  }

  private renderNameAndClanLabels() {
    // Group members are now playerId-keyed and may be in a different room
    // than this one (so no ship visual exists for them to highlight
    // anyway). For ships actually visible here, matching by display name
    // is an honest, documented approximation — ShipSchema doesn't expose
    // raw player ids to the client — good enough for a decorative ring.
    const myGroupMemberNames = new Set(this.groupState.members.map((m) => m.name));

    for (const [sessionId, node] of this.shipVisuals) {
      const triangle = shipRoot(node);
      const ship = this.shipSchemas.get(sessionId);
      if (!ship || ship.kind !== "player") continue;

      let label = this.nameLabels.get(sessionId);
      if (!label) {
        label = this.add
          .text(0, 0, "", { fontFamily: "monospace", fontSize: "10px", color: "#cfe9f0" })
          .setOrigin(0.5)
          .setDepth(7);
        this.nameLabels.set(sessionId, label);
      }

      // Phase: real ship art — the clan/personal flag banner that used to
      // be drawn here is now the ship's own flag sprite, tinted in
      // refreshPlayerShipVisual (see createShipNode/ships.onChange). This
      // Graphics object is kept only for the group-member highlight ring,
      // which has no sprite equivalent.
      let flagGfx = this.clanFlags.get(sessionId);
      if (!flagGfx) {
        flagGfx = this.add.graphics().setDepth(6);
        this.clanFlags.set(sessionId, flagGfx);
      }

      if (ship.sunk || !triangle.visible) {
        label.setVisible(false);
        flagGfx.clear();
        continue;
      }

      const name: string = ship.displayName || "?";
      label.setText(ship.clanTag ? `${name} [${ship.clanTag}]` : name);
      label.setPosition(triangle.x, triangle.y + HEALTH_BAR_OFFSET_Y - 24);
      label.setVisible(true);

      flagGfx.clear();

      // No minimap exists, so group members are highlighted directly in
      // the main view instead — a distinct ring around their ship.
      if (ship.displayName && myGroupMemberNames.has(ship.displayName)) {
        flagGfx.lineStyle(2, 0xffe066, 0.9);
        flagGfx.strokeCircle(triangle.x, triangle.y, 16);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Phase 7 (fifth/final slice), still true with real sprites: wake trail
  // cosmetic. Hull color and sail pattern are now handled directly on the
  // ship's own hull/sail Image tint (refreshPlayerShipVisual, called from
  // createShipNode/ships.onChange — no per-frame Graphics redraw needed for
  // those two anymore); the personal/clan flag is the ship's flag Image
  // tint, same place. The wake trail has no sprite equivalent (it's a
  // fading particle-style trail, not a static accent), so it stays exactly
  // as it was: one shared Graphics object cleared and redrawn every frame.
  // ---------------------------------------------------------------------

  private renderShipCosmetics() {
    this.wakeGfx.clear();
    const seenWakes = new Set<string>();

    for (const [sessionId, node] of this.shipVisuals) {
      const triangle = shipRoot(node);
      const ship = this.shipSchemas.get(sessionId);
      if (!ship || ship.sunk || !triangle.visible) continue;

      const wakeOption = WAKE_COLOR_OPTIONS[ship.cosmeticWakeColor as string];
      if (!wakeOption?.color) continue;

      seenWakes.add(sessionId);
      const history = this.wakeHistories.get(sessionId) ?? [];
      history.push({ x: triangle.x, y: triangle.y });
      while (history.length > WAKE_TRAIL_LENGTH) history.shift();
      this.wakeHistories.set(sessionId, history);

      const wakeColor = Phaser.Display.Color.HexStringToColor(wakeOption.color).color;
      for (let i = 0; i < history.length - 1; i++) {
        const point = history[i];
        const alpha = ((i + 1) / history.length) * 0.45;
        this.wakeGfx.fillStyle(wakeColor, alpha);
        this.wakeGfx.fillCircle(point.x, point.y, 4);
      }
    }

    for (const sessionId of this.wakeHistories.keys()) {
      if (!seenWakes.has(sessionId)) this.wakeHistories.delete(sessionId);
    }
  }

  // ---------------------------------------------------------------------
  // Phase 6: chat (global / group / clan channels). Always-visible panel,
  // bottom-left, independent of the dock UI.
  // ---------------------------------------------------------------------

  private createChatUI() {
    const panel = document.createElement("div");
    panel.id = "chat-panel";
    panel.innerHTML = `
      <div class="chat-tabs">
        <button data-channel="zone" class="active">Zona</button>
        <button data-channel="global">Global</button>
        <button data-channel="group">Grupo</button>
        <button data-channel="clan">Clan</button>
      </div>
      <div class="chat-messages"></div>
      <form class="chat-form">
        <input class="chat-input" type="text" maxlength="${CHAT_MAX_MESSAGE_LENGTH}" placeholder="Escribe un mensaje…" />
        <button type="submit">Enviar</button>
      </form>
    `;
    document.body.appendChild(panel);
    this.chatPanelEl = panel;
    this.chatMessagesEl = panel.querySelector(".chat-messages")!;
    this.chatInputEl = panel.querySelector(".chat-input")!;

    panel.querySelectorAll<HTMLButtonElement>(".chat-tabs button").forEach((btn) => {
      btn.addEventListener("click", () => {
        panel.querySelectorAll(".chat-tabs button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        this.chatChannel = btn.dataset.channel as ChatChannel;
        this.renderChatMessages();
      });
    });

    this.chatInputEl.addEventListener("focus", () => (this.chatInputFocused = true));
    this.chatInputEl.addEventListener("blur", () => (this.chatInputFocused = false));

    panel.querySelector(".chat-form")!.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = this.chatInputEl.value.trim();
      if (!text || !this.room) return;
      this.room.send("chat:send", { channel: this.chatChannel, text });
      this.chatInputEl.value = "";
    });
  }

  private handleChatMessage(msg: ChatMessage) {
    this.chatMessages.push(msg);
    while (this.chatMessages.length > 50) this.chatMessages.shift();
    this.renderChatMessages();
  }

  private renderChatMessages() {
    const visible = this.chatMessages.filter((m) => m.channel === this.chatChannel && !isMuted(m.senderId));

    this.chatMessagesEl.innerHTML = visible
      .map(
        (m, index) => `
        <div class="chat-row">
          <span><strong>${m.senderName}:</strong> ${m.text}</span>
          <span class="chat-row-actions">
            <button data-mute-index="${index}" title="Ignorar a este jugador">🔇</button>
            <button data-report-index="${index}" title="Reportar mensaje">⚠</button>
          </span>
        </div>`
      )
      .join("");

    this.chatMessagesEl.querySelectorAll<HTMLButtonElement>("[data-mute-index]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const msg = visible[Number(btn.dataset.muteIndex)];
        if (msg) toggleMute(msg.senderId);
        this.renderChatMessages();
      });
    });
    this.chatMessagesEl.querySelectorAll<HTMLButtonElement>("[data-report-index]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const msg = visible[Number(btn.dataset.reportIndex)];
        if (msg && this.room) this.room.send("chat:report", { reportedPlayerId: msg.senderId, text: msg.text });
      });
    });

    this.chatMessagesEl.scrollTop = this.chatMessagesEl.scrollHeight;
  }

  // ---------------------------------------------------------------------
  // Phase 6: social panel (nearby players, group status, clan panel).
  // Toggled with N — separate from the dock UI, which stays safe-zone-gated.
  // ---------------------------------------------------------------------

  private createSocialUI() {
    loadMuteList();
    const panel = document.createElement("div");
    panel.id = "social-panel";
    panel.classList.add("hidden");
    document.body.appendChild(panel);
    this.socialPanelEl = panel;
  }

  private toggleSocialPanel() {
    this.socialOpen = !this.socialOpen;
    this.socialPanelEl.classList.toggle("hidden", !this.socialOpen);
    if (this.socialOpen) this.renderSocialPanel();
  }

  private nearbyPlayers(): { sessionId: string; name: string }[] {
    const result: { sessionId: string; name: string }[] = [];
    this.shipSchemas.forEach((ship, sessionId) => {
      if (sessionId === this.room?.sessionId || ship.kind !== "player" || ship.sunk) return;
      result.push({ sessionId, name: ship.displayName || "?" });
    });
    return result;
  }

  private renderSocialPanel() {
    if (!this.socialOpen) return;

    const invitePrompt = this.pendingGroupInvite
      ? `
      <div class="dock-row">
        <span>${this.pendingGroupInvite.fromName} te invitó a un grupo</span>
        <span>
          <button class="dock-action" id="group-invite-accept">Aceptar</button>
          <button class="dock-action" id="group-invite-decline">Rechazar</button>
        </span>
      </div>`
      : "";

    const clanInvitePrompt = this.pendingClanInvite
      ? `
      <div class="dock-row">
        <span>${this.pendingClanInvite.fromName} te invitó al clan [${this.pendingClanInvite.clanTag}] ${this.pendingClanInvite.clanName}</span>
        <span>
          <button class="dock-action" id="clan-invite-accept">Aceptar</button>
          <button class="dock-action" id="clan-invite-decline">Rechazar</button>
        </span>
      </div>`
      : "";

    const nearbyRows = this.nearbyPlayers()
      .map(
        (p) => `
        <div class="dock-row">
          <span>${p.name}</span>
          <span>
            <button class="dock-action" data-group-invite="${p.sessionId}" ${this.groupState.members.length >= MAX_GROUP_SIZE ? "disabled" : ""}>+Grupo</button>
            <button class="dock-action" data-clan-invite="${p.sessionId}" ${this.canInviteToClan() ? "" : "disabled"}>+Clan</button>
          </span>
        </div>`
      )
      .join("");

    // leaderId/members[].playerId are persistent playerIds (survive a
    // member border-crossing into a different room), so "is this me"
    // compares against my own session's playerId, not this room's
    // volatile sessionId.
    const myPlayerId = getSession()?.playerId;
    const isLeader = this.groupState.leaderId === myPlayerId;
    const groupRows = this.groupState.groupId
      ? this.groupState.members
          .map(
            (m) => `
            <div class="dock-row">
              <span>${m.name}${m.playerId === this.groupState.leaderId ? " (líder)" : ""}</span>
              ${isLeader && m.playerId !== myPlayerId ? `<button class="dock-action" data-group-kick="${m.playerId}">Expulsar</button>` : ""}
            </div>`
          )
          .join("")
      : "<em>No estás en ningún grupo.</em>";

    const groupActions = this.groupState.groupId
      ? isLeader
        ? `<button class="dock-action" id="group-disband">Disolver grupo</button>`
        : `<button class="dock-action" id="group-leave">Salir del grupo</button>`
      : "";

    const clanSection = this.renderClanSection();

    this.socialPanelEl.innerHTML = `
      <strong>Jugadores cercanos</strong>
      <div>${nearbyRows || "<em>No hay otros jugadores cerca.</em>"}</div>

      <strong>Grupo (máx ${MAX_GROUP_SIZE})</strong>
      ${invitePrompt}
      <div>${groupRows}</div>
      ${groupActions}

      <strong>Clan</strong>
      ${clanInvitePrompt}
      ${clanSection}
    `;

    this.wireSocialPanelEvents();
  }

  private canInviteToClan(): boolean {
    return !!this.clanState.clan && (this.clanState.myRank === "capitan" || this.clanState.myRank === "oficial");
  }

  private renderClanSection(): string {
    if (!this.clanState.clan) {
      return `
        <form id="clan-create-form" style="display:flex; flex-direction:column; gap:4px;">
          <input id="clan-name" type="text" placeholder="Nombre del clan" maxlength="24" required />
          <input id="clan-tag" type="text" placeholder="Tag (ej. IRON)" maxlength="4" required />
          <input id="clan-color" type="color" value="#4fd8ff" />
          <button type="submit" class="dock-action">Fundar clan (500g)</button>
        </form>`;
    }

    const clan = this.clanState.clan;
    const memberRows = this.clanState.members
      .map((m) => {
        const canManage = this.clanState.myRank === "capitan" && m.rank !== "capitan";
        const canKick = canManage || (this.clanState.myRank === "oficial" && m.rank === "marinero");
        return `
        <div class="dock-row">
          <span>${m.display_name} — ${m.rank}</span>
          <span>
            ${canManage && m.rank !== "oficial" ? `<button class="dock-action" data-clan-promote="${m.player_id}">↑</button>` : ""}
            ${canManage && m.rank !== "marinero" ? `<button class="dock-action" data-clan-demote="${m.player_id}">↓</button>` : ""}
            ${canKick ? `<button class="dock-action" data-clan-kick="${m.player_id}">Expulsar</button>` : ""}
          </span>
        </div>`;
      })
      .join("");

    const bankControls = `
      <div class="dock-row">
        <span>Banco: ${clan.bank_gold}g</span>
        <span>
          <input id="clan-bank-amount" type="number" min="1" style="width:60px;" />
          <button class="dock-action" id="clan-donate">Donar</button>
          ${this.clanState.myRank === "capitan" ? `<button class="dock-action" id="clan-withdraw">Retirar</button>` : ""}
        </span>
      </div>`;

    const capitanActions =
      this.clanState.myRank === "capitan"
        ? `
        <div class="dock-row">
          <input id="clan-rename" type="text" placeholder="Nuevo nombre" maxlength="24" />
          <button class="dock-action" id="clan-rename-btn">Renombrar</button>
        </div>
        <button class="dock-action" id="clan-disband">Disolver clan</button>`
        : `<button class="dock-action" id="clan-leave">Abandonar clan</button>`;

    return `
      <div>[${clan.tag}] ${clan.name}</div>
      <div>${memberRows}</div>
      ${bankControls}
      ${capitanActions}
    `;
  }

  private wireSocialPanelEvents() {
    const panel = this.socialPanelEl;

    panel.querySelector("#group-invite-accept")?.addEventListener("click", () => {
      this.room?.send("group:respond", { accept: true });
      this.pendingGroupInvite = null;
      this.renderSocialPanel();
    });
    panel.querySelector("#group-invite-decline")?.addEventListener("click", () => {
      this.room?.send("group:respond", { accept: false });
      this.pendingGroupInvite = null;
      this.renderSocialPanel();
    });
    panel.querySelector("#clan-invite-accept")?.addEventListener("click", () => {
      this.room?.send("clan:respond", { accept: true });
      this.pendingClanInvite = null;
      this.renderSocialPanel();
    });
    panel.querySelector("#clan-invite-decline")?.addEventListener("click", () => {
      this.room?.send("clan:respond", { accept: false });
      this.pendingClanInvite = null;
      this.renderSocialPanel();
    });

    panel.querySelectorAll<HTMLButtonElement>("[data-group-invite]").forEach((btn) => {
      btn.addEventListener("click", () => this.room?.send("group:invite", { targetSessionId: btn.dataset.groupInvite }));
    });
    panel.querySelectorAll<HTMLButtonElement>("[data-clan-invite]").forEach((btn) => {
      btn.addEventListener("click", () => this.room?.send("clan:invite", { targetSessionId: btn.dataset.clanInvite }));
    });
    panel.querySelectorAll<HTMLButtonElement>("[data-group-kick]").forEach((btn) => {
      btn.addEventListener("click", () => this.room?.send("group:kick", { targetPlayerId: btn.dataset.groupKick }));
    });
    panel.querySelector("#group-leave")?.addEventListener("click", () => this.room?.send("group:leave"));
    panel.querySelector("#group-disband")?.addEventListener("click", () => this.room?.send("group:disband"));

    panel.querySelector("#clan-create-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = (panel.querySelector("#clan-name") as HTMLInputElement).value;
      const tag = (panel.querySelector("#clan-tag") as HTMLInputElement).value;
      const flagColor1 = (panel.querySelector("#clan-color") as HTMLInputElement).value;
      this.room?.send("clan:create", { name, tag, flagColor1 });
    });

    panel.querySelectorAll<HTMLButtonElement>("[data-clan-promote]").forEach((btn) => {
      btn.addEventListener("click", () => this.room?.send("clan:promote", { targetPlayerId: btn.dataset.clanPromote }));
    });
    panel.querySelectorAll<HTMLButtonElement>("[data-clan-demote]").forEach((btn) => {
      btn.addEventListener("click", () => this.room?.send("clan:demote", { targetPlayerId: btn.dataset.clanDemote }));
    });
    panel.querySelectorAll<HTMLButtonElement>("[data-clan-kick]").forEach((btn) => {
      btn.addEventListener("click", () => this.room?.send("clan:kick", { targetPlayerId: btn.dataset.clanKick }));
    });

    panel.querySelector("#clan-donate")?.addEventListener("click", () => {
      const amount = Number((panel.querySelector("#clan-bank-amount") as HTMLInputElement).value);
      if (amount > 0) this.room?.send("clan:donate", { amount });
    });
    panel.querySelector("#clan-withdraw")?.addEventListener("click", () => {
      const amount = Number((panel.querySelector("#clan-bank-amount") as HTMLInputElement).value);
      if (amount > 0) this.room?.send("clan:withdraw", { amount });
    });
    panel.querySelector("#clan-rename-btn")?.addEventListener("click", () => {
      const name = (panel.querySelector("#clan-rename") as HTMLInputElement).value;
      if (name) this.room?.send("clan:rename", { name });
    });
    panel.querySelector("#clan-disband")?.addEventListener("click", () => this.room?.send("clan:disband"));
    panel.querySelector("#clan-leave")?.addEventListener("click", () => this.room?.send("clan:leave"));
  }
}

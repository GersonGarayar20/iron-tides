import { MAX_SHIP_HIT_RADIUS } from "./shipClasses";

export const WORLD_WIDTH = 4000;
export const WORLD_HEIGHT = 4000;

export interface WorldIsland {
  x: number;
  y: number;
  radius: number;
}

export interface WorldRock {
  x: number;
  y: number;
  radius: number;
}

export interface WorldDock {
  x: number;
  y: number;
  safeRadius: number;
}

export const DOCK: WorldDock = { x: 2000, y: 2000, safeRadius: 350 };

// Phase 7 (fourth slice): fixed weekend-event boss spawn point. The plan's
// "aguas malditas" cursed-zone tier (its own level-gated zone) was never
// built past the Phase 3 safe-zone/open-PvP split, so building a full
// multi-tier zone system now just for the boss is disproportionate —
// deferred. Instead the boss spawns at a fixed, obviously-dangerous point:
// the region's farthest corner from the dock. Every region shares the same
// WORLD_WIDTH x WORLD_HEIGHT local coordinate frame with the dock at its
// exact center (2000, 2000) — islands/rocks are mirrored per region (see
// RegionDef below), but the frame itself isn't, so one fixed point here is
// equally "the far corner" in every region. (300, 300) was chosen and
// verified against every region's mirrored island/rock layout to be clear
// of all of them (nearest island edge is still >300px away in every
// region) and ~2400px from the dock, comfortably outside the safe zone.
export const BOSS_SPAWN_POINT = { x: 300, y: 300 };

export const ISLANDS: WorldIsland[] = [
  { x: 900, y: 700, radius: 220 },
  { x: 3150, y: 850, radius: 260 },
  { x: 850, y: 3200, radius: 240 },
  { x: 3250, y: 3300, radius: 200 },
];

export const ROCKS: WorldRock[] = [
  { x: 1500, y: 1100, radius: 40 },
  { x: 2550, y: 1300, radius: 36 },
  { x: 1250, y: 2600, radius: 42 },
  { x: 2700, y: 2500, radius: 38 },
  { x: 650, y: 1900, radius: 34 },
  { x: 3400, y: 2000, radius: 40 },
];

// Continuous contact damage rather than a single per-collision chunk, so
// grazing a rock is forgiving but lingering on one is not.
export const ROCK_DAMAGE_PER_SECOND = 25;

export function isInSafeZone(x: number, y: number): boolean {
  return Math.hypot(x - DOCK.x, y - DOCK.y) <= DOCK.safeRadius;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function clampToWorldBounds(
  x: number,
  y: number,
  margin = MAX_SHIP_HIT_RADIUS
): { x: number; y: number } {
  return {
    x: clamp(x, margin, WORLD_WIDTH - margin),
    y: clamp(y, margin, WORLD_HEIGHT - margin),
  };
}

// Islands are solid obstacles: a ship caught inside one is pushed back out
// along the vector from its center rather than being stopped dead, so
// sliding along a coastline feels continuous instead of sticky.
// `islands` defaults to the single-region Phase 1-6 layout so every
// pre-Phase-7 call site keeps its exact original behavior; OceanRoom passes
// its own region's island list explicitly (see RegionDef below).
export function resolveIslandCollisions(
  x: number,
  y: number,
  shipRadius = MAX_SHIP_HIT_RADIUS,
  islands: WorldIsland[] = ISLANDS
): { x: number; y: number } {
  let rx = x;
  let ry = y;

  for (const island of islands) {
    const dx = rx - island.x;
    const dy = ry - island.y;
    const distance = Math.hypot(dx, dy);
    const minDistance = island.radius + shipRadius;

    if (distance < minDistance) {
      if (distance > 0.0001) {
        const pushDistance = minDistance - distance;
        rx += (dx / distance) * pushDistance;
        ry += (dy / distance) * pushDistance;
      } else {
        rx += minDistance;
      }
    }
  }

  return { x: rx, y: ry };
}

export function findTouchingRock(
  x: number,
  y: number,
  shipRadius = MAX_SHIP_HIT_RADIUS,
  rocks: WorldRock[] = ROCKS
): WorldRock | null {
  for (const rock of rocks) {
    const distance = Math.hypot(x - rock.x, y - rock.y);
    if (distance <= rock.radius + shipRadius) return rock;
  }
  return null;
}

// ---------------------------------------------------------------------
// Phase 7 (first slice): multi-region world. DOCK/WORLD_WIDTH/WORLD_HEIGHT
// stay global/identical in every region (same bounded coordinate space
// repeated per region, each with its own dock at the same relative center)
// — only islands/rocks vary per region, as an honestly-simple placeholder
// variation. A 2x2 grid (not the plan's 3x3 example) is enough to prove
// seamless cross-region transfer + channel duplication without hand-placing
// geometry for nine regions of placeholder art; see the Phase 7 report.
// ---------------------------------------------------------------------

export type BorderSide = "north" | "south" | "east" | "west";

export interface RegionDef {
  id: string;
  name: string;
  col: number;
  row: number;
  islands: WorldIsland[];
  rocks: WorldRock[];
  neighbors: Partial<Record<BorderSide, string>>;
}

export const REGION_GRID_COLS = 2;
export const REGION_GRID_ROWS = 2;

function mirrorList<T extends { x: number; y: number }>(list: T[], mirrorX: boolean, mirrorY: boolean): T[] {
  return list.map((entry) => ({
    ...entry,
    x: mirrorX ? WORLD_WIDTH - entry.x : entry.x,
    y: mirrorY ? WORLD_HEIGHT - entry.y : entry.y,
  }));
}

export function regionIdFor(col: number, row: number): string {
  return `${col},${row}`;
}

function buildRegion(col: number, row: number): RegionDef {
  const mirrorX = col % 2 === 1;
  const mirrorY = row % 2 === 1;
  const neighbors: Partial<Record<BorderSide, string>> = {};
  if (col > 0) neighbors.west = regionIdFor(col - 1, row);
  if (col < REGION_GRID_COLS - 1) neighbors.east = regionIdFor(col + 1, row);
  if (row > 0) neighbors.north = regionIdFor(col, row - 1);
  if (row < REGION_GRID_ROWS - 1) neighbors.south = regionIdFor(col, row + 1);

  return {
    id: regionIdFor(col, row),
    name: `Region (${col}, ${row})`,
    col,
    row,
    islands: mirrorList(ISLANDS, mirrorX, mirrorY),
    rocks: mirrorList(ROCKS, mirrorX, mirrorY),
    neighbors,
  };
}

export const REGIONS: Record<string, RegionDef> = {};
for (let row = 0; row < REGION_GRID_ROWS; row++) {
  for (let col = 0; col < REGION_GRID_COLS; col++) {
    const region = buildRegion(col, row);
    REGIONS[region.id] = region;
  }
}

// The world's "capital" region — every fresh login spawns here, same as the
// single OceanRoom did pre-Phase-7.
export const DEFAULT_REGION_ID = regionIdFor(0, 0);

export function getRegion(id: string | undefined | null): RegionDef {
  return (id && REGIONS[id]) || REGIONS[DEFAULT_REGION_ID];
}

export interface BorderCrossing {
  side: BorderSide;
  neighborRegionId: string;
  entryX: number;
  entryY: number;
}

// How far inside the new region's edge an arriving ship appears — comfortably
// clear of the boundary so it doesn't immediately re-trigger a crossing.
const BORDER_ENTRY_INSET = MAX_SHIP_HIT_RADIUS * 3;

// Pure check: given a region and a ship's about-to-be-applied (pre-clamp)
// position, decide whether it just sailed off one of that region's open
// edges into a neighboring region. Returns null when there's no neighbor in
// that direction (a world-edge region just clamps as before) or the
// position is still in-bounds.
//
// The threshold here deliberately matches clampToWorldBounds's own margin
// (MAX_SHIP_HIT_RADIUS), not the raw 0/WORLD_WIDTH/WORLD_HEIGHT edges: a
// ship can never actually reach the raw edge in the first place, since
// without a neighbor clampToWorldBounds pins it MAX_SHIP_HIT_RADIUS short
// of it every tick. Checking against the raw edge would mean the crossing
// check and the clamp fight every tick — clamp always wins first, so the
// ship gets stuck oscillating a few pixels short of the raw edge and never
// crosses. This boundary margin is intentionally the same fixed value for
// every ship (the largest class's hit radius, i.e. the boss's) rather than
// each ship's own class-specific radius: it's a generic "stay clear of the
// map edge" safety margin, not tied to one ship's identity the way combat
// hit detection and terrain collision are, so a single safe-for-everyone
// constant is simpler and avoids ever letting a smaller margin let a big
// ship clip past an edge.
export function detectBorderCrossing(region: RegionDef, x: number, y: number): BorderCrossing | null {
  if (x < MAX_SHIP_HIT_RADIUS && region.neighbors.west) {
    return {
      side: "west",
      neighborRegionId: region.neighbors.west,
      entryX: WORLD_WIDTH - BORDER_ENTRY_INSET,
      entryY: clamp(y, MAX_SHIP_HIT_RADIUS, WORLD_HEIGHT - MAX_SHIP_HIT_RADIUS),
    };
  }
  if (x > WORLD_WIDTH - MAX_SHIP_HIT_RADIUS && region.neighbors.east) {
    return {
      side: "east",
      neighborRegionId: region.neighbors.east,
      entryX: BORDER_ENTRY_INSET,
      entryY: clamp(y, MAX_SHIP_HIT_RADIUS, WORLD_HEIGHT - MAX_SHIP_HIT_RADIUS),
    };
  }
  if (y < MAX_SHIP_HIT_RADIUS && region.neighbors.north) {
    return {
      side: "north",
      neighborRegionId: region.neighbors.north,
      entryX: clamp(x, MAX_SHIP_HIT_RADIUS, WORLD_WIDTH - MAX_SHIP_HIT_RADIUS),
      entryY: WORLD_HEIGHT - BORDER_ENTRY_INSET,
    };
  }
  if (y > WORLD_HEIGHT - MAX_SHIP_HIT_RADIUS && region.neighbors.south) {
    return {
      side: "south",
      neighborRegionId: region.neighbors.south,
      entryX: clamp(x, MAX_SHIP_HIT_RADIUS, WORLD_WIDTH - MAX_SHIP_HIT_RADIUS),
      entryY: BORDER_ENTRY_INSET,
    };
  }
  return null;
}

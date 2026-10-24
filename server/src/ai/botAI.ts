import {
  BOSS_FLEE_HULL_RATIO,
  BOT_ATTACK_HEADING_TOLERANCE,
  BOT_ATTACK_RANGE,
  BOT_DETECT_RANGE,
  BOT_FLEE_HULL_RATIO,
  BOT_HEADING_DEADZONE,
  BOT_PATROL_RADIUS,
  BOT_WAYPOINT_RADIUS,
  isInSafeZone,
  type BotAIState,
  type BotKind,
  type CannonSide,
  type ShipInput,
} from "@iron-tides/shared";

// Phase 7 (fourth slice): the boss's flee threshold is 0 (BOSS_FLEE_HULL_RATIO)
// — a giant ship that never runs, unlike a pirate dipping below
// BOT_FLEE_HULL_RATIO. hullRatio can never be < 0, so the "detect" check
// below never flees a boss regardless of how low its hull gets.
function fleeHullRatioFor(kind: BotKind): number {
  return kind === "boss" ? BOSS_FLEE_HULL_RATIO : BOT_FLEE_HULL_RATIO;
}

const TWO_PI = Math.PI * 2;

function normalizeAngle(angle: number): number {
  let a = angle % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a;
}

function angleDiff(from: number, to: number): number {
  let d = normalizeAngle(to) - normalizeAngle(from);
  if (d > Math.PI) d -= TWO_PI;
  if (d < -Math.PI) d += TWO_PI;
  return d;
}

function bearingTo(fromX: number, fromY: number, toX: number, toY: number): number {
  return Math.atan2(toY - fromY, toX - fromX);
}

function turnToward(currentHeading: number, desiredHeading: number): -1 | 0 | 1 {
  const diff = angleDiff(currentHeading, desiredHeading);
  if (Math.abs(diff) < BOT_HEADING_DEADZONE) return 0;
  return diff > 0 ? 1 : -1;
}

export interface BotShipSnapshot {
  x: number;
  y: number;
  heading: number;
  hull: number;
  maxHull: number;
}

export interface PlayerCandidate {
  sessionId: string;
  x: number;
  y: number;
}

export interface BotRuntimeState {
  kind: BotKind;
  homeX: number;
  homeY: number;
  waypoint: { x: number; y: number };
  targetId: string | null;
}

export interface BotDecision {
  input: ShipInput;
  fireSide: CannonSide | null;
  nextState: BotAIState;
  targetId: string | null;
  nextWaypoint?: { x: number; y: number };
}

function pickWaypoint(home: { x: number; y: number }, rng: () => number): { x: number; y: number } {
  const angle = rng() * TWO_PI;
  const distance = BOT_PATROL_RADIUS * (0.4 + rng() * 0.6);
  return { x: home.x + Math.cos(angle) * distance, y: home.y + Math.sin(angle) * distance };
}

function findNearestTarget(
  ship: BotShipSnapshot,
  players: PlayerCandidate[]
): PlayerCandidate | null {
  let nearest: PlayerCandidate | null = null;
  let nearestDistance = Infinity;

  for (const player of players) {
    if (isInSafeZone(player.x, player.y)) continue;
    const distance = Math.hypot(player.x - ship.x, player.y - ship.y);
    if (distance <= BOT_DETECT_RANGE && distance < nearestDistance) {
      nearest = player;
      nearestDistance = distance;
    }
  }

  return nearest;
}

export function decideBotAction(
  currentState: BotAIState,
  bot: BotRuntimeState,
  ship: BotShipSnapshot,
  players: PlayerCandidate[],
  rng: () => number = Math.random
): BotDecision {
  // A bot caught inside the safe zone (pushed there, or respawned too close)
  // drops any hostile intent immediately, same as a target that enters it.
  if (isInSafeZone(ship.x, ship.y)) {
    const homeBearing = bearingTo(ship.x, ship.y, bot.homeX, bot.homeY);
    return {
      input: { throttle: 1, turn: turnToward(ship.heading, homeBearing) },
      fireSide: null,
      nextState: "patrol",
      targetId: null,
    };
  }

  const hullRatio = ship.maxHull > 0 ? ship.hull / ship.maxHull : 0;
  const target = bot.targetId ? players.find((p) => p.sessionId === bot.targetId) ?? null : null;
  const targetLost =
    !target ||
    isInSafeZone(target.x, target.y) ||
    Math.hypot(target.x - ship.x, target.y - ship.y) > BOT_DETECT_RANGE * 1.4;

  switch (currentState) {
    case "patrol": {
      const found = findNearestTarget(ship, players);
      if (found) {
        return {
          input: { throttle: 0, turn: 0 },
          fireSide: null,
          nextState: "detect",
          targetId: found.sessionId,
        };
      }

      const distanceToWaypoint = Math.hypot(bot.waypoint.x - ship.x, bot.waypoint.y - ship.y);
      if (distanceToWaypoint <= BOT_WAYPOINT_RADIUS) {
        const nextWaypoint = pickWaypoint({ x: bot.homeX, y: bot.homeY }, rng);
        return {
          input: { throttle: 1, turn: 0 },
          fireSide: null,
          nextState: "patrol",
          targetId: null,
          nextWaypoint,
        };
      }

      const bearing = bearingTo(ship.x, ship.y, bot.waypoint.x, bot.waypoint.y);
      return {
        input: { throttle: 1, turn: turnToward(ship.heading, bearing) },
        fireSide: null,
        nextState: "patrol",
        targetId: null,
      };
    }

    case "detect": {
      if (!target) {
        return { input: { throttle: 0, turn: 0 }, fireSide: null, nextState: "patrol", targetId: null };
      }

      const shouldFlee = bot.kind === "merchant" || hullRatio < fleeHullRatioFor(bot.kind);
      return {
        input: { throttle: 0, turn: 0 },
        fireSide: null,
        nextState: shouldFlee ? "flee" : "pursue",
        targetId: target.sessionId,
      };
    }

    case "pursue": {
      if (targetLost) {
        return { input: { throttle: 1, turn: 0 }, fireSide: null, nextState: "patrol", targetId: null };
      }
      if (bot.kind === "pirate" && hullRatio < BOT_FLEE_HULL_RATIO) {
        return {
          input: { throttle: 1, turn: 0 },
          fireSide: null,
          nextState: "flee",
          targetId: target!.sessionId,
        };
      }

      const bearing = bearingTo(ship.x, ship.y, target!.x, target!.y);
      const distance = Math.hypot(target!.x - ship.x, target!.y - ship.y);
      return {
        input: { throttle: 1, turn: turnToward(ship.heading, bearing) },
        fireSide: null,
        nextState: distance <= BOT_ATTACK_RANGE ? "attack" : "pursue",
        targetId: target!.sessionId,
      };
    }

    case "attack": {
      if (targetLost) {
        return { input: { throttle: 1, turn: 0 }, fireSide: null, nextState: "patrol", targetId: null };
      }
      if (bot.kind === "pirate" && hullRatio < BOT_FLEE_HULL_RATIO) {
        return {
          input: { throttle: 1, turn: 0 },
          fireSide: null,
          nextState: "flee",
          targetId: target!.sessionId,
        };
      }

      const distance = Math.hypot(target!.x - ship.x, target!.y - ship.y);
      const bearing = bearingTo(ship.x, ship.y, target!.x, target!.y);

      if (distance > BOT_ATTACK_RANGE * 1.3) {
        return {
          input: { throttle: 1, turn: turnToward(ship.heading, bearing) },
          fireSide: null,
          nextState: "pursue",
          targetId: target!.sessionId,
        };
      }

      // Present whichever flank is already closer to facing the target
      // instead of re-deriving a single "correct" side every tick, so the
      // ship doesn't flip-flop broadsides while holding position.
      const portHeading = normalizeAngle(ship.heading - Math.PI / 2);
      const starboardHeading = normalizeAngle(ship.heading + Math.PI / 2);
      const side: CannonSide =
        Math.abs(angleDiff(starboardHeading, bearing)) <= Math.abs(angleDiff(portHeading, bearing))
          ? "starboard"
          : "port";
      const desiredHeading =
        side === "starboard" ? normalizeAngle(bearing - Math.PI / 2) : normalizeAngle(bearing + Math.PI / 2);
      const headingError = Math.abs(angleDiff(ship.heading, desiredHeading));

      return {
        input: { throttle: 0, turn: turnToward(ship.heading, desiredHeading) },
        fireSide: headingError <= BOT_ATTACK_HEADING_TOLERANCE ? side : null,
        nextState: "attack",
        targetId: target!.sessionId,
      };
    }

    case "flee": {
      const activeThreat =
        target &&
        !isInSafeZone(target.x, target.y) &&
        Math.hypot(target.x - ship.x, target.y - ship.y) <= BOT_DETECT_RANGE;

      if (!activeThreat) {
        const homeDistance = Math.hypot(bot.homeX - ship.x, bot.homeY - ship.y);
        if (homeDistance <= BOT_WAYPOINT_RADIUS * 2) {
          return { input: { throttle: 0, turn: 0 }, fireSide: null, nextState: "patrol", targetId: null };
        }

        const homeBearing = bearingTo(ship.x, ship.y, bot.homeX, bot.homeY);
        return {
          input: { throttle: 1, turn: turnToward(ship.heading, homeBearing) },
          fireSide: null,
          nextState: "flee",
          targetId: null,
        };
      }

      const awayBearing = bearingTo(target!.x, target!.y, ship.x, ship.y);
      return {
        input: { throttle: 1, turn: turnToward(ship.heading, awayBearing) },
        fireSide: null,
        nextState: "flee",
        targetId: target!.sessionId,
      };
    }
  }
}

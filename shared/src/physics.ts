import {
  ACCELERATION,
  CANNON_ORIGIN_OFFSET,
  DRAG,
  MAX_SPEED,
  REVERSE_SPEED_FACTOR,
  TURN_ACCELERATION,
  TURN_RATE,
} from "./constants";
import type {
  CannonballPhysicsState,
  CannonSide,
  ShipInput,
  ShipPhysicsState,
} from "./types";

const TWO_PI = Math.PI * 2;

function normalizeAngle(angle: number): number {
  let a = angle % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// Phase 4 lets a ship's class/upgrades override maxSpeed and turnRate (the
// only two movement axes the plan names); acceleration/drag/turn-acceleration
// stay global feel constants, not per-ship stats. Defaults reproduce the
// exact Phase 1-3 constants, so any caller that omits params is unaffected.
export interface ShipPhysicsParams {
  maxSpeed: number;
  acceleration: number;
  drag: number;
  turnRate: number;
  turnAcceleration: number;
  reverseSpeedFactor: number;
}

const DEFAULT_PHYSICS_PARAMS: ShipPhysicsParams = {
  maxSpeed: MAX_SPEED,
  acceleration: ACCELERATION,
  drag: DRAG,
  turnRate: TURN_RATE,
  turnAcceleration: TURN_ACCELERATION,
  reverseSpeedFactor: REVERSE_SPEED_FACTOR,
};

export function stepShip(
  state: ShipPhysicsState,
  input: ShipInput,
  dtSeconds: number,
  params: ShipPhysicsParams = DEFAULT_PHYSICS_PARAMS
): ShipPhysicsState {
  const { maxSpeed, acceleration, drag, turnRate: baseTurnRate, turnAcceleration, reverseSpeedFactor } =
    params;

  let speed = state.speed;

  if (input.throttle !== 0) {
    speed += input.throttle * acceleration * dtSeconds;
  } else if (speed > 0) {
    speed = Math.max(0, speed - drag * dtSeconds);
  } else if (speed < 0) {
    speed = Math.min(0, speed + drag * dtSeconds);
  }

  const minSpeed = -maxSpeed * reverseSpeedFactor;
  speed = clamp(speed, minSpeed, maxSpeed);

  // Rudder bite ramps with current speed instead of being an on/off switch.
  // ShipPhysicsState intentionally has no stored angular velocity, so this
  // speed-coupling is what makes turning feel gradual rather than snapping
  // straight to a new heading: a ship dead in the water barely answers the
  // helm, and only carves hard once it has built up speed.
  const speedRatio = clamp(Math.abs(speed) / maxSpeed, 0, 1);
  const rudderBite = 1 - Math.exp(-turnAcceleration * speedRatio);
  const turnRate = baseTurnRate * rudderBite;

  let heading = state.heading;
  if (input.turn !== 0) {
    heading = normalizeAngle(heading + input.turn * turnRate * dtSeconds);
  }

  const x = state.x + Math.cos(heading) * speed * dtSeconds;
  const y = state.y + Math.sin(heading) * speed * dtSeconds;

  return { x, y, heading, speed };
}

export function stepCannonball(
  state: CannonballPhysicsState,
  dtSeconds: number
): CannonballPhysicsState {
  return {
    x: state.x + state.vx * dtSeconds,
    y: state.y + state.vy * dtSeconds,
    vx: state.vx,
    vy: state.vy,
  };
}

// Phase 7 (fourth slice): the boss's special attack is a heavier
// omnidirectional volley instead of a normal single-side broadside. Pure
// direction spread so OceanRoom's fireBossVolley can reuse the exact same
// cannonball spawn/step machinery (CannonballSchema + stepCannonball +
// CANNONBALL_SPEED) as every normal shot — just evenly spaced all the way
// around the circle instead of the two broadside sides.
export function getOmniVolleyDirections(count: number): { dirX: number; dirY: number }[] {
  const directions: { dirX: number; dirY: number }[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * TWO_PI;
    directions.push({ dirX: Math.cos(angle), dirY: Math.sin(angle) });
  }
  return directions;
}

export function getCannonFiringOrigin(
  ship: Pick<ShipPhysicsState, "x" | "y" | "heading">,
  side: CannonSide
): { x: number; y: number; dirX: number; dirY: number } {
  // Canvas y is down, so for a ship facing heading 0 (east) its right hand
  // (starboard) points toward +y (south) — i.e. heading + 90°, not - 90°.
  const sign = side === "starboard" ? 1 : -1;
  const angle = ship.heading + sign * (Math.PI / 2);
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);

  return {
    x: ship.x + dirX * CANNON_ORIGIN_OFFSET,
    y: ship.y + dirY * CANNON_ORIGIN_OFFSET,
    dirX,
    dirY,
  };
}

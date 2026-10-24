export interface ShipInput {
  throttle: -1 | 0 | 1;
  turn: -1 | 0 | 1;
}

export interface ShipPhysicsState {
  x: number;
  y: number;
  heading: number;
  speed: number;
}

export type CannonSide = "port" | "starboard";

export interface CannonballPhysicsState {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

// Phase 7 (fourth slice): "boss" is the weekend-event giant ship — reuses
// every bit of pirate/merchant bot infrastructure (schema, AI state
// machine, spawn tick) rather than a parallel system; see
// shared/src/events.ts and server/src/rooms/OceanRoom.ts.
export type BotKind = "pirate" | "merchant" | "boss";
export type ShipKind = "player" | BotKind;

// Exact 5-state machine: patrol between waypoints; detect is the one-tick
// transition where a target is noticed and attack-or-flee gets decided;
// pursue closes to broadside range; attack holds/fires; flee runs home.
export type BotAIState = "patrol" | "detect" | "pursue" | "attack" | "flee";

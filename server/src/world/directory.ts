import type { OceanRoom } from "../rooms/OceanRoom";

// Phase 7 (first slice): now that the world is split into multiple
// region+channel OceanRoom instances in this one Node process, nothing
// Colyseus gives us for free knows "which room is player X in right now".
// This is that lightweight in-process directory — plain server memory, no
// Redis/DB, rebuilt from scratch on every restart (same lifetime as the
// room instances themselves). Used for: global chat (reach every room),
// group/clan chat and clan roster pushes (reach a specific player who may
// now be in a different region+channel room than the sender).
export interface PlayerLocation {
  playerId: string;
  sessionId: string;
  regionId: string;
  channel: number;
  roomKey: string;
}

const rooms = new Map<string, OceanRoom>();
const playerLocations = new Map<string, PlayerLocation>();

// Per-region counter for display-only channel numbers ("Channel 2",
// "Channel 3", ...). Only advances when a brand new channel room is
// actually created (every existing channel for that region is full/locked)
// — see OceanRoom.onCreate + the Colyseus `filterBy(["regionId"])` +
// `maxClients` combo in server/src/index.ts that picks an existing
// under-cap room automatically before ever reaching here.
const regionChannelCounters = new Map<string, number>();

export function roomKeyFor(regionId: string, channel: number): string {
  return `${regionId}#${channel}`;
}

export function nextChannelNumber(regionId: string): number {
  const next = (regionChannelCounters.get(regionId) ?? 0) + 1;
  regionChannelCounters.set(regionId, next);
  return next;
}

export function registerRoom(key: string, room: OceanRoom): void {
  rooms.set(key, room);
}

export function unregisterRoom(key: string): void {
  rooms.delete(key);
}

export function getRoom(key: string): OceanRoom | undefined {
  return rooms.get(key);
}

export function allRooms(): OceanRoom[] {
  return [...rooms.values()];
}

export function setPlayerLocation(loc: PlayerLocation): void {
  playerLocations.set(loc.playerId, loc);
}

// Guards against a border-crossing transfer's fresh onJoin (which already
// registered the player at their new room) losing its entry to the old
// room's onLeave firing a moment later for the stale session.
export function clearPlayerLocationIfSession(playerId: string, sessionId: string): void {
  const current = playerLocations.get(playerId);
  if (current && current.sessionId === sessionId) playerLocations.delete(playerId);
}

export function getPlayerLocation(playerId: string): PlayerLocation | undefined {
  return playerLocations.get(playerId);
}

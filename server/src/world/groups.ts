// Phase 6 groups ("alianzas temporales") stay in-memory-only, non-persisted
// — but as of Phase 7 (first slice) membership is keyed by persistent
// playerId rather than a room-local session id, since a member can now
// border-cross into a different region+channel room than the one they
// were invited in. This module is a process-wide singleton (not per-room)
// for exactly that reason; OceanRoom still owns the invite/accept/kick
// message handlers and all Client-facing I/O, this just holds the roster.
export interface GroupState {
  id: string;
  leaderId: string; // playerId
  memberIds: Set<string>; // playerId
}

const groups = new Map<string, GroupState>();
const playerGroupId = new Map<string, string>();
let groupCount = 0;

export function getGroup(groupId: string): GroupState | undefined {
  return groups.get(groupId);
}

export function getGroupIdForPlayer(playerId: string | undefined | null): string | undefined {
  return playerId ? playerGroupId.get(playerId) : undefined;
}

export function createGroup(leaderId: string): GroupState {
  const id = `group-${groupCount++}`;
  const group: GroupState = { id, leaderId, memberIds: new Set([leaderId]) };
  groups.set(id, group);
  playerGroupId.set(leaderId, id);
  return group;
}

export function addMember(groupId: string, playerId: string): void {
  groups.get(groupId)?.memberIds.add(playerId);
  playerGroupId.set(playerId, groupId);
}

export function removeMember(playerId: string): { group: GroupState; wasLeader: boolean } | undefined {
  const groupId = playerGroupId.get(playerId);
  if (!groupId) return undefined;
  const group = groups.get(groupId);
  playerGroupId.delete(playerId);
  if (!group) return undefined;

  const wasLeader = group.leaderId === playerId;
  group.memberIds.delete(playerId);
  if (group.memberIds.size === 0) groups.delete(groupId);
  return { group, wasLeader };
}

// Removes every member (used when the leader leaves/disbands): returns the
// group as it was right before disbanding so the caller can notify members.
export function disbandGroup(groupId: string): GroupState | undefined {
  const group = groups.get(groupId);
  if (!group) return undefined;
  for (const memberId of group.memberIds) playerGroupId.delete(memberId);
  groups.delete(groupId);
  return group;
}

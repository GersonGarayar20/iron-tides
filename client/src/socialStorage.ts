// Phase 6 mute: client-side only, per the plan — a local ignore-list of
// player ids whose chat messages this client stops rendering. There is no
// server-side mute state in this phase; muting one client never affects
// what any other client (or the server) sees.
const STORAGE_KEY = "iron-tides-muted-players";

let muted: Set<string> | null = null;

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...(muted ?? [])]));
  } catch {
    // Private mode / quota exceeded: mutes still work for this tab/session.
  }
}

export function loadMuteList(): Set<string> {
  if (muted) return muted;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    muted = new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    muted = new Set();
  }
  return muted;
}

export function isMuted(playerId: string): boolean {
  return loadMuteList().has(playerId);
}

export function toggleMute(playerId: string): boolean {
  const list = loadMuteList();
  if (list.has(playerId)) {
    list.delete(playerId);
  } else {
    list.add(playerId);
  }
  persist();
  return list.has(playerId);
}

// Tiny localStorage-backed session so a guest (or logged-in) player resumes
// the same identity on return visits instead of minting a new guest every
// page load.
const STORAGE_KEY = "iron-tides-session";

export interface SessionInfo {
  token: string;
  playerId: string;
  displayName: string;
  isGuest: boolean;
}

let current: SessionInfo | null = null;

export function loadStoredSession(): SessionInfo | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    current = JSON.parse(raw) as SessionInfo;
    return current;
  } catch {
    return null;
  }
}

export function setSession(session: SessionInfo): void {
  current = session;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Private mode / quota exceeded: session still works for this tab.
  }
}

export function getSession(): SessionInfo | null {
  return current;
}

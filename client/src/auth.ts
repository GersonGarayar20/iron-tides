// Relative path, not an absolute localhost URL: Vite's dev proxy forwards
// /auth to the game server, so this works whether the page was loaded from
// localhost or a tunnel (ngrok etc.) exposing only the Vite port.
const API_BASE = "/auth";

export interface AuthResponsePlayer {
  id: string;
  isGuest: boolean;
  email: string | null;
  displayName: string;
  gold: number;
  level: number;
  xp: number;
}

export interface AuthResponse {
  token: string;
  player: AuthResponsePlayer;
}

async function postJson(path: string, body?: unknown, token?: string): Promise<AuthResponse> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? "request failed");
  return data as AuthResponse;
}

export function playAsGuest(): Promise<AuthResponse> {
  return postJson("/guest");
}

export function register(email: string, password: string, displayName?: string): Promise<AuthResponse> {
  return postJson("/register", { email, password, displayName });
}

export function login(email: string, password: string): Promise<AuthResponse> {
  return postJson("/login", { email, password });
}

// Converts the guest session identified by `token` into a real account in
// place; the returned token authenticates the same player id.
export function upgradeToAccount(token: string, email: string, password: string): Promise<AuthResponse> {
  return postJson("/upgrade", { email, password }, token);
}

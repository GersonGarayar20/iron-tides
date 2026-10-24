// Phase 5 ranking: the one piece of the Tavern that's plain REST (per the
// plan) rather than a Colyseus room message — fetched on demand when the
// ranking panel is opened, same as auth.ts's REST calls.
// Relative, same reason as auth.ts: works through Vite's dev proxy and
// through a tunnel exposing only the Vite port.
const API_BASE = "/tavern";

export interface RankingEntry {
  displayName: string;
  title: string | null;
  value: number;
}

export interface RankingResponse {
  metric: "gold_earned" | "bots_sunk";
  ranking: RankingEntry[];
}

export async function fetchWeeklyRanking(metric: "gold_earned" | "bots_sunk"): Promise<RankingResponse> {
  const res = await fetch(`${API_BASE}/ranking?metric=${metric}`);
  if (!res.ok) throw new Error("failed to load ranking");
  return res.json() as Promise<RankingResponse>;
}

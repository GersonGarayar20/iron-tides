import { pool } from "./pool";

export interface PlayerRow {
  id: string;
  is_guest: boolean;
  email: string | null;
  password_hash: string | null;
  display_name: string;
  gold: number;
  level: number;
  xp: number;
  honor: number;
  pirate_flag_until: Date | null;
  bounty: number;
  created_at: Date;
  // Phase 7 (fifth/final slice): purely cosmetic — see shared/src/cosmetics.ts.
  cosmetic_hull_color: string;
  cosmetic_sail_pattern: string;
  cosmetic_flag_color: string;
  cosmetic_wake_color: string;
}

export async function findPlayerById(id: string): Promise<PlayerRow | null> {
  const { rows } = await pool.query<PlayerRow>("SELECT * FROM players WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function findPlayerByEmail(email: string): Promise<PlayerRow | null> {
  const { rows } = await pool.query<PlayerRow>("SELECT * FROM players WHERE email = $1", [email]);
  return rows[0] ?? null;
}

export async function createGuestPlayer(): Promise<PlayerRow> {
  const displayName = `Guest-${Math.random().toString(36).slice(2, 8)}`;
  const { rows } = await pool.query<PlayerRow>(
    `INSERT INTO players (is_guest, display_name) VALUES (true, $1) RETURNING *`,
    [displayName]
  );
  return rows[0];
}

export async function createAccountPlayer(
  email: string,
  passwordHash: string,
  displayName: string
): Promise<PlayerRow> {
  const { rows } = await pool.query<PlayerRow>(
    `INSERT INTO players (is_guest, email, password_hash, display_name)
     VALUES (false, $1, $2, $3) RETURNING *`,
    [email, passwordHash, displayName]
  );
  return rows[0];
}

// Converts an existing guest row into a real account in place, preserving
// its id/gold/ships — never creates a second player row. Returns null if the
// player was already a real account (prevents clobbering an existing one).
export async function upgradeGuestToAccount(
  playerId: string,
  email: string,
  passwordHash: string
): Promise<PlayerRow | null> {
  const { rows } = await pool.query<PlayerRow>(
    `UPDATE players SET is_guest = false, email = $2, password_hash = $3
     WHERE id = $1 AND is_guest = true RETURNING *`,
    [playerId, email, passwordHash]
  );
  return rows[0] ?? null;
}

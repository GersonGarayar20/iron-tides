import { pool } from "./pool";
import { creditGold } from "./dock";

export async function adjustHonor(playerId: string, delta: number): Promise<number> {
  const { rows } = await pool.query<{ honor: number }>(
    `UPDATE players SET honor = honor + $1 WHERE id = $2 RETURNING honor`,
    [delta, playerId]
  );
  return rows[0]?.honor ?? 0;
}

// Atomic conditional set: only applies while the attacker has no currently
// active flag, so a flagged pirate's timer is never extended by a further
// unprovoked attack (see OceanRoom.maybeFlagPirate for the full rule — the
// target also has to be currently unflagged for this to even be called).
export async function setPirateFlagIfUnflagged(playerId: string, until: Date): Promise<boolean> {
  const { rows } = await pool.query(
    `UPDATE players SET pirate_flag_until = $1
     WHERE id = $2 AND (pirate_flag_until IS NULL OR pirate_flag_until < now())
     RETURNING id`,
    [until, playerId]
  );
  return rows.length > 0;
}

export async function incrementBounty(playerId: string, amount: number): Promise<number> {
  const { rows } = await pool.query<{ bounty: number }>(
    `UPDATE players SET bounty = bounty + $1 WHERE id = $2 RETURNING bounty`,
    [amount, playerId]
  );
  return rows[0]?.bounty ?? 0;
}

// Pays the target's current bounty to the killer via the normal creditGold
// path (its own "bounty_payout" transaction type) and resets it to 0. The
// flag itself is left alone — it expires on its own PIRATE_FLAG_DURATION
// timer rather than clearing immediately on death.
export async function payoutBounty(targetPlayerId: string, killerPlayerId: string): Promise<number> {
  const { rows } = await pool.query<{ bounty: number }>(
    `UPDATE players SET bounty = 0 WHERE id = $1 AND bounty > 0 RETURNING bounty`,
    [targetPlayerId]
  );
  const amount = rows[0]?.bounty ?? 0;
  if (amount > 0) await creditGold(killerPlayerId, amount, "bounty_payout");
  return amount;
}

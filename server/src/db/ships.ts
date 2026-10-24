import {
  computeShipStats,
  STARTER_SHIP_CLASS,
  ZERO_UPGRADES,
  type CargoHold,
  type ShipClassKey,
  type UpgradeLevels,
} from "@iron-tides/shared";
import { pool } from "./pool";

export interface ShipRow {
  id: string;
  player_id: string;
  class: ShipClassKey;
  upgrades: UpgradeLevels;
  hull: number;
  ammo: number;
  // Phase 7 (second slice): commodity -> quantity, same sparse-JSONB
  // convention as `upgrades`. Missing/empty means an empty hold.
  cargo: CargoHold;
  is_active: boolean;
  created_at: Date;
}

export async function createStarterShip(
  playerId: string,
  classKey: ShipClassKey = STARTER_SHIP_CLASS
): Promise<ShipRow> {
  const stats = computeShipStats(classKey, ZERO_UPGRADES);
  const { rows } = await pool.query<ShipRow>(
    `INSERT INTO ships (player_id, class, upgrades, hull, ammo, is_active)
     VALUES ($1, $2, $3::jsonb, $4, $5, true) RETURNING *`,
    [playerId, classKey, JSON.stringify(ZERO_UPGRADES), stats.maxHull, stats.maxAmmo]
  );
  return rows[0];
}

export async function getActiveShip(playerId: string): Promise<ShipRow | null> {
  const { rows } = await pool.query<ShipRow>(
    `SELECT * FROM ships WHERE player_id = $1 AND is_active = true LIMIT 1`,
    [playerId]
  );
  return rows[0] ?? null;
}

export async function getShipsByPlayer(playerId: string): Promise<ShipRow[]> {
  const { rows } = await pool.query<ShipRow>(
    `SELECT * FROM ships WHERE player_id = $1 ORDER BY created_at ASC`,
    [playerId]
  );
  return rows;
}

// Used by the safe-zone-entry / autosave / disconnect save points. Gold
// never needs a batched save here — every gold-affecting action already
// writes through to Postgres immediately (see db/dock.ts).
export async function persistShipHull(shipId: string, hull: number): Promise<void> {
  await pool.query(`UPDATE ships SET hull = $1 WHERE id = $2`, [hull, shipId]);
}

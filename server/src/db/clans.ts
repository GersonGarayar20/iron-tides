import { CLAN_CREATION_COST, clanRankAtLeast, type ClanRank } from "@iron-tides/shared";
import { creditGold, debitGold, withTransaction } from "./dock";
import { pool } from "./pool";

export interface ClanRow {
  id: string;
  name: string;
  tag: string;
  flag_color_1: string;
  flag_color_2: string | null;
  bank_gold: number;
  created_at: Date;
}

export interface ClanMemberRow {
  clan_id: string;
  player_id: string;
  rank: ClanRank;
  joined_at: Date;
}

export interface ClanMembership {
  clan: ClanRow;
  member: ClanMemberRow;
}

export interface ClanRosterEntry {
  player_id: string;
  display_name: string;
  rank: ClanRank;
  joined_at: Date;
}

interface ActionResult<T> {
  ok: boolean;
  reason?: string;
  gold?: number;
  data?: T;
}

export async function getClanForPlayer(playerId: string): Promise<ClanMembership | null> {
  const { rows } = await pool.query<ClanRow & Omit<ClanMemberRow, "rank"> & { rank: ClanRank }>(
    `SELECT c.*, cm.player_id, cm.clan_id, cm.rank, cm.joined_at
     FROM clan_members cm JOIN clans c ON c.id = cm.clan_id
     WHERE cm.player_id = $1`,
    [playerId]
  );
  const row = rows[0];
  if (!row) return null;

  return {
    clan: {
      id: row.id,
      name: row.name,
      tag: row.tag,
      flag_color_1: row.flag_color_1,
      flag_color_2: row.flag_color_2,
      bank_gold: row.bank_gold,
      created_at: row.created_at,
    },
    member: { clan_id: row.clan_id, player_id: row.player_id, rank: row.rank, joined_at: row.joined_at },
  };
}

export async function getClanMembers(clanId: string): Promise<ClanRosterEntry[]> {
  const { rows } = await pool.query<ClanRosterEntry>(
    `SELECT cm.player_id, p.display_name, cm.rank, cm.joined_at
     FROM clan_members cm JOIN players p ON p.id = cm.player_id
     WHERE cm.clan_id = $1 ORDER BY cm.joined_at ASC`,
    [clanId]
  );
  return rows;
}

// Costs CLAN_CREATION_COST gold to discourage spam; the debit and the two
// inserts (clan row + the creator as capitan) run in one transaction, same
// atomic discipline as every dock purchase in db/dock.ts.
export async function createClan(
  playerId: string,
  name: string,
  tag: string,
  flagColor1: string,
  flagColor2: string | undefined
): Promise<ActionResult<ClanRow>> {
  const existing = await getClanForPlayer(playerId);
  if (existing) return { ok: false, reason: "already in a clan" };

  return withTransaction(async (client) => {
    const balance = await debitGold(client, playerId, CLAN_CREATION_COST, "clan_creation");
    if (balance === null) return { ok: false, reason: "insufficient gold" };

    try {
      const { rows } = await client.query<ClanRow>(
        `INSERT INTO clans (name, tag, flag_color_1, flag_color_2) VALUES ($1, $2, $3, $4) RETURNING *`,
        [name, tag, flagColor1, flagColor2 ?? null]
      );
      const clan = rows[0];
      await client.query(`INSERT INTO clan_members (clan_id, player_id, rank) VALUES ($1, $2, 'capitan')`, [
        clan.id,
        playerId,
      ]);
      return { ok: true, gold: balance, data: clan };
    } catch (err: any) {
      if (err?.code === "23505") return { ok: false, reason: "clan name already taken" };
      throw err;
    }
  });
}

// Called on an invited player's accept — see OceanRoom's clan:respond
// handler, which gates the invite itself on the inviter's rank before this
// is ever reached.
export async function joinClan(playerId: string, clanId: string): Promise<ActionResult<ClanRow>> {
  const existing = await getClanForPlayer(playerId);
  if (existing) return { ok: false, reason: "already in a clan" };

  try {
    await pool.query(`INSERT INTO clan_members (clan_id, player_id, rank) VALUES ($1, $2, 'marinero')`, [
      clanId,
      playerId,
    ]);
  } catch (err: any) {
    if (err?.code === "23503") return { ok: false, reason: "clan no longer exists" };
    if (err?.code === "23505") return { ok: false, reason: "already in a clan" };
    throw err;
  }

  const { rows } = await pool.query<ClanRow>(`SELECT * FROM clans WHERE id = $1`, [clanId]);
  return { ok: true, data: rows[0] };
}

export async function renameClan(actingPlayerId: string, newName: string): Promise<ActionResult<ClanRow>> {
  const acting = await getClanForPlayer(actingPlayerId);
  if (!acting || acting.member.rank !== "capitan") {
    return { ok: false, reason: "only the capitan can rename the clan" };
  }

  try {
    const { rows } = await pool.query<ClanRow>(`UPDATE clans SET name = $1 WHERE id = $2 RETURNING *`, [
      newName,
      acting.clan.id,
    ]);
    return { ok: true, data: rows[0] };
  } catch (err: any) {
    if (err?.code === "23505") return { ok: false, reason: "clan name already taken" };
    throw err;
  }
}

export async function disbandClan(actingPlayerId: string): Promise<ActionResult<{ clanId: string; memberIds: string[] }>> {
  const acting = await getClanForPlayer(actingPlayerId);
  if (!acting || acting.member.rank !== "capitan") {
    return { ok: false, reason: "only the capitan can disband the clan" };
  }

  const members = await getClanMembers(acting.clan.id);
  await pool.query(`DELETE FROM clans WHERE id = $1`, [acting.clan.id]); // cascades clan_members
  return { ok: true, data: { clanId: acting.clan.id, memberIds: members.map((m) => m.player_id) } };
}

// capitan can kick anyone (except itself); oficial can only kick marinero.
// Rank-change/kick targets are addressed by playerId (from the roster the
// client already has), not sessionId — clan membership outlives a session.
export async function kickClanMember(actingPlayerId: string, targetPlayerId: string): Promise<ActionResult<null>> {
  const acting = await getClanForPlayer(actingPlayerId);
  if (!acting) return { ok: false, reason: "not in a clan" };

  const target = await getClanForPlayer(targetPlayerId);
  if (!target || target.clan.id !== acting.clan.id) return { ok: false, reason: "target not in your clan" };
  if (target.member.rank === "capitan") return { ok: false, reason: "cannot kick the capitan" };

  const canKick = acting.member.rank === "capitan" || (acting.member.rank === "oficial" && target.member.rank === "marinero");
  if (!canKick) return { ok: false, reason: "insufficient rank" };

  await pool.query(`DELETE FROM clan_members WHERE player_id = $1`, [targetPlayerId]);
  return { ok: true };
}

export async function leaveClan(playerId: string): Promise<ActionResult<null>> {
  const membership = await getClanForPlayer(playerId);
  if (!membership) return { ok: false, reason: "not in a clan" };
  if (membership.member.rank === "capitan") {
    return { ok: false, reason: "the capitan must disband or transfer the clan first" };
  }

  await pool.query(`DELETE FROM clan_members WHERE player_id = $1`, [playerId]);
  return { ok: true };
}

// capitan-only; limited to promoting/demoting between oficial and marinero
// — captaincy transfer isn't part of the Phase 6 checklist and is
// deliberately not implemented.
export async function setClanMemberRank(
  actingPlayerId: string,
  targetPlayerId: string,
  rank: Exclude<ClanRank, "capitan">
): Promise<ActionResult<null>> {
  const acting = await getClanForPlayer(actingPlayerId);
  if (!acting || acting.member.rank !== "capitan") return { ok: false, reason: "only the capitan can change ranks" };

  const target = await getClanForPlayer(targetPlayerId);
  if (!target || target.clan.id !== acting.clan.id) return { ok: false, reason: "target not in your clan" };
  if (target.member.rank === "capitan") return { ok: false, reason: "cannot change the capitan's rank" };

  await pool.query(`UPDATE clan_members SET rank = $1 WHERE player_id = $2`, [rank, targetPlayerId]);
  return { ok: true };
}

// Any rank can donate — a real atomic gold-debit-from-player /
// credit-to-clan-bank transfer, same discipline as db/dock.ts.
export async function donateToBank(playerId: string, amount: number): Promise<ActionResult<ClanRow>> {
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "invalid amount" };

  const membership = await getClanForPlayer(playerId);
  if (!membership) return { ok: false, reason: "not in a clan" };

  return withTransaction(async (client) => {
    const balance = await debitGold(client, playerId, Math.floor(amount), "clan_bank_donate");
    if (balance === null) return { ok: false, reason: "insufficient gold" };

    const { rows } = await client.query<ClanRow>(
      `UPDATE clans SET bank_gold = bank_gold + $1 WHERE id = $2 RETURNING *`,
      [Math.floor(amount), membership.clan.id]
    );
    return { ok: true, gold: balance, data: rows[0] };
  });
}

// Only the capitan can withdraw (documented choice — officers can invite
// and kick marineros, but bank withdrawal stays capitan-only).
export async function withdrawFromBank(playerId: string, amount: number): Promise<ActionResult<ClanRow>> {
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "invalid amount" };

  const membership = await getClanForPlayer(playerId);
  if (!membership) return { ok: false, reason: "not in a clan" };
  if (membership.member.rank !== "capitan") return { ok: false, reason: "only the capitan can withdraw from the bank" };

  return withTransaction(async (client) => {
    const { rows: updated } = await client.query<ClanRow>(
      `UPDATE clans SET bank_gold = bank_gold - $1 WHERE id = $2 AND bank_gold >= $1 RETURNING *`,
      [Math.floor(amount), membership.clan.id]
    );
    if (!updated[0]) return { ok: false, reason: "insufficient clan bank balance" };

    const balance = await creditGold(playerId, Math.floor(amount), "clan_bank_withdraw", client);
    return { ok: true, gold: balance, data: updated[0] };
  });
}

// Small helper the room uses to gate invite permission before even showing
// the target a prompt.
export function canActOnClanAs(member: ClanMemberRow, min: ClanRank): boolean {
  return clanRankAtLeast(member.rank, min);
}

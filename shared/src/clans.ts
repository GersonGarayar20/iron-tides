// Phase 6 clans: persistent alliances (clans / clan_members tables in
// Postgres — see server/src/db/clans.ts). Clan wars and shared clan
// missions are flavor text in the plan, not in the Phase 6 checklist, and
// are deliberately skipped — Phase 5's mission system stays player-scoped.
export type ClanRank = "capitan" | "oficial" | "marinero";

// Ordered lowest-to-highest so clanRankAtLeast can compare numerically.
const RANK_ORDER: Record<ClanRank, number> = {
  marinero: 1,
  oficial: 2,
  capitan: 3,
};

export function clanRankAtLeast(rank: ClanRank, min: ClanRank): boolean {
  return RANK_ORDER[rank] >= RANK_ORDER[min];
}

// Costs gold to discourage spamming new clans; kept as a single flat fee
// rather than anything scaling, matching the plan's "keep it simple" note.
export const CLAN_CREATION_COST = 500;

export const CLAN_NAME_MAX_LENGTH = 24;
export const CLAN_TAG_MAX_LENGTH = 4;

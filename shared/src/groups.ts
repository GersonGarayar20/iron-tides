// Phase 6 groups: the plan's "alianzas temporales" — in-memory only, scoped
// to the current room, unlike clans (which are persisted in Postgres). No
// shared pure logic beyond the cap itself; the invite/accept/kick state
// machine lives entirely in OceanRoom since it's inherently per-connection.
export const MAX_GROUP_SIZE = 4;

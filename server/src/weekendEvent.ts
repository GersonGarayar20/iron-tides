import { isWeekendEvent } from "@iron-tides/shared";

// Phase 7 (fourth slice): FORCE_WEEKEND_EVENT lets verification force the
// weekend boss+double-gold event active regardless of the real UTC date,
// read once at server boot — same override pattern as REGION_CHANNEL_CAP
// (see shared/src/constants.ts's DEFAULT_REGION_CHANNEL_CAP comment and
// OceanRoom.ts's own REGION_CHANNEL_CAP constant). Not a gameplay knob.
const FORCE_WEEKEND_EVENT = process.env.FORCE_WEEKEND_EVENT === "true";

// Single source of truth for "is the weekend event on right now", reused
// by both OceanRoom's boss-spawn gate and db/dock.ts's creditGold
// double-gold gate so the two can never drift apart from each other.
export function isWeekendEventActive(now: Date = new Date()): boolean {
  return FORCE_WEEKEND_EVENT || isWeekendEvent(now);
}

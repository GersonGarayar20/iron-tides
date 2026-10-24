// Phase 7 (fourth slice): weekend events and bosses.
//
// The event window is exactly "the weekend" in UTC: every UTC calendar day
// whose day-of-week is Saturday or Sunday, i.e. Saturday 00:00:00.000 UTC
// through Sunday 23:59:59.999 UTC inclusive. Checking UTC day-of-week
// directly (rather than hour/date arithmetic against a start/end instant)
// makes both boundaries exact with no off-by-one, and needs no cron job —
// same lazy "check it when you need it" pattern already used for daily
// task resets (utcDateString) and weekly challenges (utcWeekStartString).
//
// This is the single source of truth for "is the weekend event on" — both
// the boss-spawn gate (OceanRoom) and the double-gold gate (db/dock.ts's
// creditGold, via server/src/weekendEvent.ts's env-override wrapper) call
// this exact function so the two can never drift apart.
export function isWeekendEvent(now: Date): boolean {
  const utcDay = now.getUTCDay(); // 0 = Sunday, 6 = Saturday
  return utcDay === 0 || utcDay === 6;
}

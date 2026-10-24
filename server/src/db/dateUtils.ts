// Phase 5 date helpers: every "today"/"this week" boundary (daily task
// reset, login streak, weekly stats) is computed in UTC, in plain
// 'YYYY-MM-DD' strings, matched against Postgres DATE columns. pool.ts
// registers a type parser so node-pg returns DATE columns as the same raw
// string instead of re-interpreting them through the server process's
// local timezone (a well-known pg footgun that otherwise causes off-by-one
// day bugs).

export function utcDateString(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// ISO (Monday-start) week, computed in UTC.
export function utcWeekStartString(): string {
  const d = new Date();
  const day = d.getUTCDay(); // 0 (Sun) .. 6 (Sat)
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diffToMonday);
  return d.toISOString().slice(0, 10);
}

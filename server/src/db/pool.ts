import { Pool, types } from "pg";

// Phase 5: DATE columns (task_date, week_start_date, last_login_date) are
// compared against plain UTC 'YYYY-MM-DD' strings from dateUtils.ts.
// node-pg's default DATE parser returns a JS Date reinterpreted through the
// server process's local timezone, which can shift the date by a day —
// returning the raw string instead keeps every comparison exact. 1082 is
// the DATE type oid.
types.setTypeParser(1082, (value: string) => value);

// Falls back to the exact credentials docker-compose.yml provisions, so a
// freshly-cloned repo works with zero .env setup once the container is up.
export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://iron_tides:iron_tides_dev@localhost:5432/iron_tides",
});

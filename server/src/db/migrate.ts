import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { pool } from "./pool";

const moduleDir = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(): Promise<void> {
  const sql = readFileSync(join(moduleDir, "schema.sql"), "utf-8");
  await pool.query(sql);
}

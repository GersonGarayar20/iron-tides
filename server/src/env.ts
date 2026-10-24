import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

// Loads the repo-root .env into process.env without adding a dotenv
// dependency. Must be the very first import in index.ts: ESM evaluates
// imported modules in declaration order, so this runs before db/pool.ts or
// auth/jwt.ts read process.env at their own module-load time. Missing .env
// is fine — every value that matters has a dev-sane fallback elsewhere.
const ENV_PATH = resolve(process.cwd(), "../.env");

function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;

  const content = readFileSync(path, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(ENV_PATH);

export { ENV_PATH };

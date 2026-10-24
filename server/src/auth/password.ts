import bcrypt from "bcryptjs";

// bcryptjs (pure JS) instead of bcrypt/argon2 (native bindings) — this repo
// already hit native-build-script friction in Phase 1 with esbuild and
// msgpackr-extract, so a pure-JS hash implementation avoids repeating it.
const SALT_ROUNDS = 10;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

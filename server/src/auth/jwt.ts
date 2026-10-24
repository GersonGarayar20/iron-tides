import { randomBytes } from "crypto";
import { appendFileSync } from "fs";
import jwt from "jsonwebtoken";
import { ENV_PATH } from "../env";

const EXPIRES_IN = "30d";

function resolveSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;

  // Dev convenience: generate once and persist to the gitignored root .env
  // so tokens survive a server restart instead of invalidating every
  // session. Never hardcode a real secret in committed source.
  const generated = randomBytes(32).toString("hex");
  try {
    appendFileSync(ENV_PATH, `\nJWT_SECRET=${generated}\n`);
  } catch {
    // Best-effort; fall back to an in-memory-only secret for this process.
  }
  process.env.JWT_SECRET = generated;
  return generated;
}

const SECRET = resolveSecret();

export interface AuthTokenPayload {
  playerId: string;
}

export function signAuthToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN });
}

export function verifyAuthToken(token: string): AuthTokenPayload {
  const decoded = jwt.verify(token, SECRET);
  if (typeof decoded !== "object" || decoded === null || typeof (decoded as any).playerId !== "string") {
    throw new Error("malformed token payload");
  }
  return { playerId: (decoded as any).playerId };
}

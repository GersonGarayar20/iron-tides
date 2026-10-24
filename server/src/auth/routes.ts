import { Router } from "express";
import {
  createAccountPlayer,
  createGuestPlayer,
  findPlayerByEmail,
  findPlayerById,
  type PlayerRow,
  upgradeGuestToAccount,
} from "../db/players";
import { createStarterShip } from "../db/ships";
import { signAuthToken, verifyAuthToken } from "./jwt";
import { hashPassword, verifyPassword } from "./password";

export const authRouter = Router();

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function sanitizePlayer(player: PlayerRow) {
  return {
    id: player.id,
    isGuest: player.is_guest,
    email: player.email,
    displayName: player.display_name,
    gold: player.gold,
    level: player.level,
    xp: player.xp,
  };
}

authRouter.post("/guest", async (_req, res) => {
  try {
    const player = await createGuestPlayer();
    await createStarterShip(player.id);
    const token = signAuthToken({ playerId: player.id });
    res.json({ token, player: sanitizePlayer(player) });
  } catch (err) {
    console.error("[auth] guest failed", err);
    res.status(500).json({ error: "failed to create guest session" });
  }
});

authRouter.post("/register", async (req, res) => {
  const { email, password, displayName } = req.body ?? {};
  if (!isNonEmptyString(email) || !isNonEmptyString(password)) {
    res.status(400).json({ error: "email and password are required" });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: "password must be at least 8 characters" });
    return;
  }

  try {
    const existing = await findPlayerByEmail(email);
    if (existing) {
      res.status(409).json({ error: "email already registered" });
      return;
    }

    const passwordHash = await hashPassword(password);
    const name = isNonEmptyString(displayName) ? displayName : email.split("@")[0];
    const player = await createAccountPlayer(email, passwordHash, name);
    await createStarterShip(player.id);

    const token = signAuthToken({ playerId: player.id });
    res.json({ token, player: sanitizePlayer(player) });
  } catch (err) {
    console.error("[auth] register failed", err);
    res.status(500).json({ error: "failed to register" });
  }
});

authRouter.post("/login", async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!isNonEmptyString(email) || !isNonEmptyString(password)) {
    res.status(400).json({ error: "email and password are required" });
    return;
  }

  try {
    const player = await findPlayerByEmail(email);
    if (!player || !player.password_hash) {
      res.status(401).json({ error: "invalid credentials" });
      return;
    }

    const valid = await verifyPassword(password, player.password_hash);
    if (!valid) {
      res.status(401).json({ error: "invalid credentials" });
      return;
    }

    const token = signAuthToken({ playerId: player.id });
    res.json({ token, player: sanitizePlayer(player) });
  } catch (err) {
    console.error("[auth] login failed", err);
    res.status(500).json({ error: "failed to login" });
  }
});

// Upgrades the caller's existing guest player row to a real account in
// place: same player id, same gold, same ships. Never creates a second row.
authRouter.post("/upgrade", async (req, res) => {
  const authHeader = req.header("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  if (!token) {
    res.status(401).json({ error: "missing auth token" });
    return;
  }

  let playerId: string;
  try {
    playerId = verifyAuthToken(token).playerId;
  } catch {
    res.status(401).json({ error: "invalid or expired token" });
    return;
  }

  const { email, password } = req.body ?? {};
  if (!isNonEmptyString(email) || !isNonEmptyString(password)) {
    res.status(400).json({ error: "email and password are required" });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: "password must be at least 8 characters" });
    return;
  }

  try {
    const current = await findPlayerById(playerId);
    if (!current) {
      res.status(404).json({ error: "player not found" });
      return;
    }
    if (!current.is_guest) {
      res.status(409).json({ error: "account is already registered" });
      return;
    }

    const existing = await findPlayerByEmail(email);
    if (existing) {
      res.status(409).json({ error: "email already registered" });
      return;
    }

    const passwordHash = await hashPassword(password);
    const player = await upgradeGuestToAccount(playerId, email, passwordHash);
    if (!player) {
      res.status(409).json({ error: "account is already registered" });
      return;
    }

    const newToken = signAuthToken({ playerId: player.id });
    res.json({ token: newToken, player: sanitizePlayer(player) });
  } catch (err) {
    console.error("[auth] upgrade failed", err);
    res.status(500).json({ error: "failed to upgrade account" });
  }
});

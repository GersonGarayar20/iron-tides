import "./env";
import { createServer } from "http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import express from "express";
import { REGIONS } from "@iron-tides/shared";
import { authRouter } from "./auth/routes";
import { seedDockPrices } from "./db/commodities";
import { runMigrations } from "./db/migrate";
import { OceanRoom } from "./rooms/OceanRoom";
import { tavernRouter } from "./tavern/routes";

const PORT = Number(process.env.PORT ?? 2567);

const app = express();
app.use(express.json());
// Minimal hand-rolled CORS: the client runs on a different dev port
// (5173) and only needs a couple of auth routes, so a dependency is
// overkill — Colyseus's own WS transport doesn't need CORS at all.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});
app.use("/auth", authRouter);
app.use("/tavern", tavernRouter);

// Express app mounted on the same http.Server as Colyseus: `ws` only hooks
// the 'upgrade' event when given an existing server, leaving 'request'
// (ordinary HTTP) free for Express — no second Node process needed for the
// handful of auth REST routes.
const httpServer = createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

// Phase 7 (first slice): filterBy(["regionId"]) + each room's own
// this.maxClients (set per-instance in OceanRoom.onCreate from
// REGION_CHANNEL_CAP) is what gives channels for free — Colyseus's
// matchmaker already picks an existing under-cap room with a matching
// regionId, or creates a fresh one (the next channel) once every existing
// one for that region is full/locked. No custom channel-selection code
// needed beyond that.
gameServer.define("ocean", OceanRoom).filterBy(["regionId"]);

async function main() {
  await runMigrations();
  // Phase 7 (second slice): idempotent dock-price seed, same "runs every
  // boot, DB uniqueness makes repeats a no-op" discipline as runMigrations.
  await seedDockPrices(Object.keys(REGIONS));
  await gameServer.listen(PORT);
  console.log(`Iron Tides server listening on ws://localhost:${PORT}`);
}

main().catch((err) => {
  console.error("[server] failed to start", err);
  process.exit(1);
});

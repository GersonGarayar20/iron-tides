import { Router } from "express";
import { getWeeklyRanking } from "../db/tavern";

// Mounted on the same Express app as authRouter (see index.ts) — plain
// SQL ORDER BY ... LIMIT 20, no Redis, no real-time push. The client
// fetches this on demand when the ranking panel is opened, per the plan.
export const tavernRouter = Router();

tavernRouter.get("/ranking", async (req, res) => {
  const metric = req.query.metric === "bots_sunk" ? "bots_sunk" : "gold_earned";

  try {
    const rows = await getWeeklyRanking(metric);
    res.json({
      metric,
      ranking: rows.map((r) => ({ displayName: r.display_name, title: r.title, value: Number(r.value) })),
    });
  } catch (err) {
    console.error("[tavern] ranking failed", err);
    res.status(500).json({ error: "failed to load ranking" });
  }
});

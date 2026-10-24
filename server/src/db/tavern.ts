import {
  ACHIEVEMENTS,
  generateDailyTask,
  generateDailyTaskSet,
  WEEKLY_CHALLENGES,
  type BotKind,
  type CazaParams,
  type DailyTaskType,
  type MissionOffer,
  type MissionParams,
  type MissionType,
} from "@iron-tides/shared";
import { creditGold } from "./dock";
import { utcDateString, utcWeekStartString } from "./dateUtils";
import { pool } from "./pool";

// ---------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------

export interface DailyTaskRow {
  id: string;
  player_id: string;
  task_date: string;
  task_type: DailyTaskType;
  target: number;
  progress: number;
  reward_gold: number;
  claimed: boolean;
  created_at: Date;
}

export interface MissionRow {
  id: string;
  player_id: string;
  mission_type: MissionType;
  params: MissionParams;
  progress: number;
  target: number;
  reward_gold: number;
  status: "active" | "completed" | "failed";
  created_at: Date;
}

export interface WeeklyStatsRow {
  player_id: string;
  week_start_date: string;
  gold_earned: number;
  bots_sunk: number;
  players_sunk: number;
  claimed_goals: Record<string, boolean>;
}

interface ActionResult<T> {
  ok: boolean;
  reason?: string;
  gold?: number;
  data?: T;
}

// ---------------------------------------------------------------------
// Central event hook. Called from the exact places gold is credited
// (rewardBotKill / awardLoot in OceanRoom), the bot/player sink logic, the
// successful-fire path in tryFire, and mission completion. Updates today's
// daily-task progress, this week's weekly_stats row, and lifetime
// achievement-progress counters in one place.
// ---------------------------------------------------------------------

export type PlayerEventKind =
  | "gold_earned"
  | "bot_sunk"
  | "player_sunk"
  | "cannon_fired"
  | "mission_completed"
  // Phase 7 (fourth slice): a weekend-event boss kill. Deliberately
  // separate from bot_sunk — it bumps its own lifetime_bosses_sunk column
  // (for the boss_slayer achievement) rather than lifetime_bots_sunk, and
  // intentionally has no daily-task/weekly-stats mapping below (a boss
  // kill is a rare, event-only occurrence, not a dailies/weekly-goal stat).
  | "boss_sunk";

export interface PlayerEvent {
  kind: PlayerEventKind;
  // Gold amount for gold_earned; ignored (treated as +1) for every other kind.
  amount?: number;
  // Bot kind for bot_sunk, so Caza mission filters can match it.
  botKind?: BotKind;
}

const EVENT_TO_DAILY_TASK_TYPE: Partial<Record<PlayerEventKind, DailyTaskType>> = {
  gold_earned: "earn_gold",
  cannon_fired: "fire_cannons",
  mission_completed: "complete_missions",
};

const EVENT_TO_WEEKLY_COLUMN: Partial<Record<PlayerEventKind, "gold_earned" | "bots_sunk" | "players_sunk">> = {
  gold_earned: "gold_earned",
  bot_sunk: "bots_sunk",
  player_sunk: "players_sunk",
};

const EVENT_TO_LIFETIME_COLUMN: Partial<Record<PlayerEventKind, string>> = {
  gold_earned: "lifetime_gold_earned",
  bot_sunk: "lifetime_bots_sunk",
  player_sunk: "lifetime_players_sunk",
  mission_completed: "lifetime_missions_completed",
  boss_sunk: "lifetime_bosses_sunk",
};

export async function recordPlayerEvent(playerId: string, event: PlayerEvent): Promise<void> {
  await Promise.all([
    bumpDailyTaskProgress(playerId, event),
    bumpWeeklyStats(playerId, event),
    bumpLifetimeCounters(playerId, event),
    bumpCazaMissionProgress(playerId, event),
  ]);

  // Achievements read the lifetime counters the steps above just wrote, so
  // this runs last.
  await checkAchievements(playerId);
}

async function bumpDailyTaskProgress(playerId: string, event: PlayerEvent): Promise<void> {
  const taskType = EVENT_TO_DAILY_TASK_TYPE[event.kind];
  if (!taskType) return;

  const amount = taskType === "earn_gold" ? Math.max(0, Math.floor(event.amount ?? 0)) : 1;
  if (amount <= 0) return;

  const today = utcDateString();
  // Clamped server-side (LEAST) so an overshoot (e.g. a 50-shot broadside
  // against a target of 20) never reports more than 100% complete.
  await pool.query(
    `UPDATE daily_tasks SET progress = LEAST(target, progress + $1)
     WHERE player_id = $2 AND task_date = $3 AND task_type = $4 AND progress < target`,
    [amount, playerId, today, taskType]
  );
}

async function bumpWeeklyStats(playerId: string, event: PlayerEvent): Promise<void> {
  const column = EVENT_TO_WEEKLY_COLUMN[event.kind];
  if (!column) return;

  const amount = column === "gold_earned" ? Math.max(0, Math.floor(event.amount ?? 0)) : 1;
  if (amount <= 0) return;

  const weekStart = utcWeekStartString();
  // column is one of the 3 fixed literals above, never user input.
  await pool.query(
    `INSERT INTO weekly_stats (player_id, week_start_date, ${column})
     VALUES ($1, $2, $3)
     ON CONFLICT (player_id, week_start_date)
     DO UPDATE SET ${column} = weekly_stats.${column} + $3`,
    [playerId, weekStart, amount]
  );

  await maybeGrantWeeklyChallenges(playerId, weekStart);
}

async function maybeGrantWeeklyChallenges(playerId: string, weekStart: string): Promise<void> {
  const { rows } = await pool.query<WeeklyStatsRow>(
    `SELECT * FROM weekly_stats WHERE player_id = $1 AND week_start_date = $2`,
    [playerId, weekStart]
  );
  const row = rows[0];
  if (!row) return;

  for (const def of WEEKLY_CHALLENGES) {
    if (row[def.statKey] < def.threshold) continue;

    // Atomic claim-and-check: only the caller that flips the jsonb flag
    // from unset to true gets a row back, so the reward is granted exactly
    // once even under concurrent events for the same player.
    const { rows: claimed } = await pool.query(
      `UPDATE weekly_stats SET claimed_goals = claimed_goals || jsonb_build_object($1, true)
       WHERE player_id = $2 AND week_start_date = $3
         AND NOT COALESCE((claimed_goals->$1)::boolean, false)
       RETURNING player_id`,
      [def.key, playerId, weekStart]
    );
    if (claimed.length === 0) continue;

    await creditGold(playerId, def.rewardGold, "weekly_challenge");
  }
}

async function bumpLifetimeCounters(playerId: string, event: PlayerEvent): Promise<void> {
  const column = EVENT_TO_LIFETIME_COLUMN[event.kind];
  if (!column) return;

  const amount = column === "lifetime_gold_earned" ? Math.max(0, Math.floor(event.amount ?? 0)) : 1;
  if (amount <= 0) return;

  await pool.query(`UPDATE players SET ${column} = ${column} + $1 WHERE id = $2`, [amount, playerId]);
}

async function bumpCazaMissionProgress(playerId: string, event: PlayerEvent): Promise<void> {
  if (event.kind !== "bot_sunk") return;

  const { rows } = await pool.query<MissionRow>(
    `SELECT * FROM missions WHERE player_id = $1 AND mission_type = 'caza' AND status = 'active'`,
    [playerId]
  );

  for (const mission of rows) {
    const params = mission.params as CazaParams;
    if (params.botKind && params.botKind !== event.botKind) continue;

    const nextProgress = Math.min(mission.target, mission.progress + 1);
    await pool.query(`UPDATE missions SET progress = $1 WHERE id = $2 AND status = 'active'`, [
      nextProgress,
      mission.id,
    ]);

    if (nextProgress >= mission.target) {
      await completeMission(playerId, mission.id);
    }
  }
}

async function checkAchievements(playerId: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT lifetime_bots_sunk, lifetime_gold_earned, lifetime_missions_completed,
            lifetime_players_sunk, streak_count, lifetime_bosses_sunk
     FROM players WHERE id = $1`,
    [playerId]
  );
  const player = rows[0];
  if (!player) return;

  for (const def of ACHIEVEMENTS) {
    const value = Number(player[def.statKey] ?? 0);
    if (value < def.threshold) continue;

    const { rows: inserted } = await pool.query(
      `INSERT INTO player_achievements (player_id, achievement_key) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING achievement_key`,
      [playerId, def.key]
    );
    if (inserted.length === 0) continue; // already unlocked

    if (def.rewardGold > 0) await creditGold(playerId, def.rewardGold, "achievement_reward");
    if (def.rewardTitle) {
      await pool.query(`UPDATE players SET title = $1 WHERE id = $2`, [def.rewardTitle, playerId]);
    }
  }
}

// ---------------------------------------------------------------------
// Daily tasks
// ---------------------------------------------------------------------

export async function ensureDailyTasks(playerId: string): Promise<DailyTaskRow[]> {
  const today = utcDateString();
  const { rows: existing } = await pool.query<DailyTaskRow>(
    `SELECT * FROM daily_tasks WHERE player_id = $1 AND task_date = $2 ORDER BY created_at ASC`,
    [playerId, today]
  );
  if (existing.length > 0) return existing;

  const generated = generateDailyTaskSet();
  for (const task of generated) {
    // ON CONFLICT guards the (player_id, task_date, task_type) race if
    // onJoin and a tavern:open land in the same instant.
    await pool.query(
      `INSERT INTO daily_tasks (player_id, task_date, task_type, target, reward_gold)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (player_id, task_date, task_type) DO NOTHING`,
      [playerId, today, task.taskType, task.target, task.rewardGold]
    );
  }

  const { rows } = await pool.query<DailyTaskRow>(
    `SELECT * FROM daily_tasks WHERE player_id = $1 AND task_date = $2 ORDER BY created_at ASC`,
    [playerId, today]
  );
  return rows;
}

export async function claimDailyTask(playerId: string, taskId: string): Promise<ActionResult<DailyTaskRow>> {
  const { rows } = await pool.query<DailyTaskRow>(
    `UPDATE daily_tasks SET claimed = true
     WHERE id = $1 AND player_id = $2 AND claimed = false AND progress >= target
     RETURNING *`,
    [taskId, playerId]
  );
  const task = rows[0];
  if (!task) return { ok: false, reason: "task not claimable" };

  const gold = await creditGold(playerId, task.reward_gold, "daily_task_reward");
  return { ok: true, gold, data: task };
}

export async function rerollDailyTask(playerId: string, taskId: string): Promise<ActionResult<DailyTaskRow>> {
  const today = utcDateString();

  // Atomically claim the day's single reroll allowance before touching
  // the task itself.
  const { rows: allowance } = await pool.query(
    `INSERT INTO daily_reroll_used (player_id, task_date) VALUES ($1, $2)
     ON CONFLICT DO NOTHING RETURNING player_id`,
    [playerId, today]
  );
  if (allowance.length === 0) return { ok: false, reason: "reroll already used today" };

  const { rows: taskRows } = await pool.query<DailyTaskRow>(
    `SELECT * FROM daily_tasks WHERE id = $1 AND player_id = $2 AND task_date = $3 AND claimed = false`,
    [taskId, playerId, today]
  );
  const task = taskRows[0];
  if (!task) {
    // Give the allowance back so a bad task id doesn't burn it.
    await pool.query(`DELETE FROM daily_reroll_used WHERE player_id = $1 AND task_date = $2`, [
      playerId,
      today,
    ]);
    return { ok: false, reason: "task not found" };
  }

  const regenerated = generateDailyTask(task.task_type);
  const { rows: updated } = await pool.query<DailyTaskRow>(
    `UPDATE daily_tasks SET target = $1, reward_gold = $2, progress = 0 WHERE id = $3 RETURNING *`,
    [regenerated.target, regenerated.rewardGold, taskId]
  );
  return { ok: true, data: updated[0] };
}

export async function hasUsedRerollToday(playerId: string): Promise<boolean> {
  const today = utcDateString();
  const { rows } = await pool.query(`SELECT 1 FROM daily_reroll_used WHERE player_id = $1 AND task_date = $2`, [
    playerId,
    today,
  ]);
  return rows.length > 0;
}

// ---------------------------------------------------------------------
// Missions
// ---------------------------------------------------------------------

export async function createMission(playerId: string, offer: MissionOffer): Promise<ActionResult<MissionRow>> {
  try {
    const { rows } = await pool.query<MissionRow>(
      `INSERT INTO missions (player_id, mission_type, params, progress, target, reward_gold)
       VALUES ($1, $2, $3::jsonb, 0, $4, $5) RETURNING *`,
      [playerId, offer.type, JSON.stringify(offer.params), offer.target, offer.rewardGold]
    );
    return { ok: true, data: rows[0] };
  } catch (err: any) {
    if (err?.code === "23505") return { ok: false, reason: "a mission of this type is already active" };
    throw err;
  }
}

export async function getActiveMissions(playerId: string): Promise<MissionRow[]> {
  const { rows } = await pool.query<MissionRow>(
    `SELECT * FROM missions WHERE player_id = $1 AND status = 'active' ORDER BY created_at ASC`,
    [playerId]
  );
  return rows;
}

export async function updateMissionProgress(missionId: string, progress: number): Promise<void> {
  await pool.query(`UPDATE missions SET progress = $1 WHERE id = $2 AND status = 'active'`, [
    progress,
    missionId,
  ]);
}

export async function completeMission(playerId: string, missionId: string): Promise<void> {
  const { rows } = await pool.query<MissionRow>(
    `UPDATE missions SET status = 'completed', progress = target
     WHERE id = $1 AND player_id = $2 AND status = 'active' RETURNING *`,
    [missionId, playerId]
  );
  const mission = rows[0];
  if (!mission) return;

  await creditGold(playerId, mission.reward_gold, "mission_reward");
  await recordPlayerEvent(playerId, { kind: "mission_completed" });
}

export async function failMission(playerId: string, missionId: string): Promise<void> {
  await pool.query(`UPDATE missions SET status = 'failed' WHERE id = $1 AND player_id = $2 AND status = 'active'`, [
    missionId,
    playerId,
  ]);
}

// ---------------------------------------------------------------------
// Login streak
// ---------------------------------------------------------------------

export interface LoginStreakResult {
  streakCount: number;
  chestGold: number | null;
}

export async function updateLoginStreak(
  playerId: string,
  chestInterval: number,
  chestGold: number
): Promise<LoginStreakResult> {
  const today = utcDateString();
  const { rows } = await pool.query<{ last_login_date: string | null; streak_count: number }>(
    `SELECT last_login_date, streak_count FROM players WHERE id = $1`,
    [playerId]
  );
  const player = rows[0];
  if (!player) return { streakCount: 0, chestGold: null };

  if (player.last_login_date === today) {
    return { streakCount: player.streak_count, chestGold: null };
  }

  const yesterday = utcDateString(-1);
  const nextStreak = player.last_login_date === yesterday ? player.streak_count + 1 : 1;

  await pool.query(`UPDATE players SET streak_count = $1, last_login_date = $2 WHERE id = $3`, [
    nextStreak,
    today,
    playerId,
  ]);

  let grantedChestGold: number | null = null;
  if (nextStreak % chestInterval === 0) {
    grantedChestGold = chestGold;
    await creditGold(playerId, chestGold, "login_streak_chest");
  }

  await checkAchievements(playerId);
  return { streakCount: nextStreak, chestGold: grantedChestGold };
}

// ---------------------------------------------------------------------
// Weekly stats / ranking
// ---------------------------------------------------------------------

const EMPTY_WEEKLY_STATS: Omit<WeeklyStatsRow, "player_id" | "week_start_date"> = {
  gold_earned: 0,
  bots_sunk: 0,
  players_sunk: 0,
  claimed_goals: {},
};

// Read-only: a row is only ever written lazily by bumpWeeklyStats on the
// first event of a new week, per the plan. A player with no events yet
// this week simply reads as all-zero, nothing is inserted here.
export async function getWeeklyStatsOrDefault(playerId: string): Promise<WeeklyStatsRow> {
  const weekStart = utcWeekStartString();
  const { rows } = await pool.query<WeeklyStatsRow>(
    `SELECT * FROM weekly_stats WHERE player_id = $1 AND week_start_date = $2`,
    [playerId, weekStart]
  );
  return rows[0] ?? { player_id: playerId, week_start_date: weekStart, ...EMPTY_WEEKLY_STATS };
}

export interface RankingRow {
  display_name: string;
  title: string | null;
  value: number;
}

export async function getWeeklyRanking(
  metric: "gold_earned" | "bots_sunk",
  limit = 20
): Promise<RankingRow[]> {
  const weekStart = utcWeekStartString();
  const column = metric === "bots_sunk" ? "bots_sunk" : "gold_earned";

  const { rows } = await pool.query<RankingRow>(
    `SELECT p.display_name, p.title, ws.${column} AS value
     FROM weekly_stats ws
     JOIN players p ON p.id = ws.player_id
     WHERE ws.week_start_date = $1
     ORDER BY ws.${column} DESC
     LIMIT $2`,
    [weekStart, limit]
  );
  return rows;
}

// ---------------------------------------------------------------------
// Achievements listing
// ---------------------------------------------------------------------

export async function getPlayerAchievements(playerId: string): Promise<Map<string, Date>> {
  const { rows } = await pool.query<{ achievement_key: string; unlocked_at: Date }>(
    `SELECT achievement_key, unlocked_at FROM player_achievements WHERE player_id = $1`,
    [playerId]
  );
  return new Map(rows.map((r) => [r.achievement_key, r.unlocked_at]));
}

// ---------------------------------------------------------------------
// Full Tavern-tab bundle: everything the client's one `tavern:state`
// payload needs, assembled from the pieces above plus the shared static
// definitions. Ranking is intentionally excluded — it's its own REST
// endpoint, fetched on demand when the ranking panel opens.
// ---------------------------------------------------------------------

export interface TavernAchievementView {
  key: string;
  title: string;
  description: string;
  threshold: number;
  rewardGold: number;
  rewardTitle?: string;
  unlocked: boolean;
  unlockedAt: Date | null;
}

export interface TavernWeeklyChallengeView {
  key: string;
  title: string;
  threshold: number;
  rewardGold: number;
  progress: number;
  claimed: boolean;
}

export interface TavernBundle {
  dailyTasks: DailyTaskRow[];
  rerollAvailable: boolean;
  missions: MissionRow[];
  streak: { count: number; lastLoginDate: string | null };
  weeklyChallenges: TavernWeeklyChallengeView[];
  achievements: TavernAchievementView[];
  gold: number;
  title: string | null;
}

export async function getTavernBundle(playerId: string): Promise<TavernBundle> {
  const [dailyTasks, rerollUsed, missions, playerRow, weekly, unlocked] = await Promise.all([
    ensureDailyTasks(playerId),
    hasUsedRerollToday(playerId),
    getActiveMissions(playerId),
    pool
      .query<{
        gold: number;
        streak_count: number;
        last_login_date: string | null;
        title: string | null;
      }>(`SELECT gold, streak_count, last_login_date, title FROM players WHERE id = $1`, [playerId])
      .then((r) => r.rows[0]),
    getWeeklyStatsOrDefault(playerId),
    getPlayerAchievements(playerId),
  ]);

  const weeklyChallenges: TavernWeeklyChallengeView[] = WEEKLY_CHALLENGES.map((def) => ({
    key: def.key,
    title: def.title,
    threshold: def.threshold,
    rewardGold: def.rewardGold,
    progress: weekly[def.statKey],
    claimed: Boolean(weekly.claimed_goals?.[def.key]),
  }));

  const achievements: TavernAchievementView[] = ACHIEVEMENTS.map((def) => ({
    key: def.key,
    title: def.title,
    description: def.description,
    threshold: def.threshold,
    rewardGold: def.rewardGold,
    rewardTitle: def.rewardTitle,
    unlocked: unlocked.has(def.key),
    unlockedAt: unlocked.get(def.key) ?? null,
  }));

  return {
    dailyTasks,
    rerollAvailable: !rerollUsed,
    missions,
    streak: { count: playerRow?.streak_count ?? 0, lastLoginDate: playerRow?.last_login_date ?? null },
    weeklyChallenges,
    achievements,
    gold: playerRow?.gold ?? 0,
    title: playerRow?.title ?? null,
  };
}

// Phase 5 daily tasks: level-agnostic templates with random targets, each
// trackable through the single recordPlayerEvent hook (gold_earned,
// cannon_fired, mission_completed — bot_sunk/player_sunk deliberately have
// no daily-task template, they only feed weekly stats + lifetime
// achievements).
export type DailyTaskType = "earn_gold" | "fire_cannons" | "complete_missions";

export interface DailyTaskTemplate {
  type: DailyTaskType;
  title: string;
  targetRange: readonly [number, number];
  rewardForTarget: (target: number) => number;
}

export const DAILY_TASK_TEMPLATES: Record<DailyTaskType, DailyTaskTemplate> = {
  earn_gold: {
    type: "earn_gold",
    title: "Ganar oro",
    targetRange: [50, 150],
    rewardForTarget: (target) => Math.round(target * 0.5),
  },
  fire_cannons: {
    type: "fire_cannons",
    title: "Disparar cañones",
    targetRange: [15, 40],
    rewardForTarget: (target) => Math.round(target * 1.5),
  },
  complete_missions: {
    type: "complete_missions",
    title: "Completar misiones",
    targetRange: [1, 2],
    rewardForTarget: (target) => target * 60,
  },
};

export const DAILY_TASK_TYPES = Object.keys(DAILY_TASK_TEMPLATES) as DailyTaskType[];

export interface GeneratedDailyTask {
  taskType: DailyTaskType;
  target: number;
  rewardGold: number;
}

function randomInt(rng: () => number, min: number, max: number): number {
  return Math.floor(min + rng() * (max - min + 1));
}

export function generateDailyTask(type: DailyTaskType, rng: () => number = Math.random): GeneratedDailyTask {
  const template = DAILY_TASK_TEMPLATES[type];
  const [min, max] = template.targetRange;
  const target = randomInt(rng, min, max);
  return { taskType: type, target, rewardGold: template.rewardForTarget(target) };
}

// Exactly one task per template, so a fresh day always offers all 3 kinds.
export function generateDailyTaskSet(rng: () => number = Math.random): GeneratedDailyTask[] {
  return DAILY_TASK_TYPES.map((type) => generateDailyTask(type, rng));
}

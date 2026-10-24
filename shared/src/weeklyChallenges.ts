// Phase 5 weekly challenges: derived directly from the current week's
// weekly_stats row against this small fixed set of goals — no separate
// weekly_challenges table. Granted once per week automatically (not
// claimed by hand like daily tasks) the moment the stat crosses the
// threshold; see db/tavern.ts maybeGrantWeeklyChallenges.
export interface WeeklyChallengeDef {
  key: string;
  title: string;
  statKey: "bots_sunk" | "gold_earned" | "players_sunk";
  threshold: number;
  rewardGold: number;
}

export const WEEKLY_CHALLENGES: WeeklyChallengeDef[] = [
  {
    key: "weekly_bots_50",
    title: "Hundir 50 barcos esta semana",
    statKey: "bots_sunk",
    threshold: 50,
    rewardGold: 150,
  },
  {
    key: "weekly_gold_2000",
    title: "Ganar 2000 de oro esta semana",
    statKey: "gold_earned",
    threshold: 2000,
    rewardGold: 150,
  },
  {
    key: "weekly_players_10",
    title: "Hundir 10 jugadores en mar abierto esta semana",
    statKey: "players_sunk",
    threshold: 10,
    rewardGold: 300,
  },
];

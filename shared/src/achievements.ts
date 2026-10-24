// Phase 5 achievements: static definitions, lifetime ("ever") thresholds
// backed by the lifetime_* columns on players (plus streak_count for the
// login-streak achievement). No cosmetic/sprite system exists, so the only
// rewards are a gold bonus and/or a text "title" shown next to the
// player's name — never an item/sprite unlock.
export type AchievementStatKey =
  | "lifetime_bots_sunk"
  | "lifetime_gold_earned"
  | "lifetime_missions_completed"
  | "lifetime_players_sunk"
  | "streak_count"
  | "lifetime_bosses_sunk";

export interface AchievementDef {
  key: string;
  title: string;
  description: string;
  statKey: AchievementStatKey;
  threshold: number;
  rewardGold: number;
  rewardTitle?: string;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  {
    key: "first_blood",
    title: "Primera Sangre",
    description: "Hunde tu primer barco.",
    statKey: "lifetime_bots_sunk",
    threshold: 1,
    rewardGold: 20,
    rewardTitle: "Corsario Novato",
  },
  {
    key: "bot_hunter_50",
    title: "Cazador de Piratas",
    description: "Hunde 50 barcos a lo largo de tu carrera.",
    statKey: "lifetime_bots_sunk",
    threshold: 50,
    rewardGold: 200,
    rewardTitle: "Azote de los Mares",
  },
  {
    key: "gold_hoarder_1000",
    title: "Comerciante",
    description: "Gana 1000 de oro a lo largo de tu carrera.",
    statKey: "lifetime_gold_earned",
    threshold: 1000,
    rewardGold: 100,
    rewardTitle: "Comerciante Próspero",
  },
  {
    key: "gold_hoarder_10000",
    title: "Magnate",
    description: "Gana 10000 de oro a lo largo de tu carrera.",
    statKey: "lifetime_gold_earned",
    threshold: 10000,
    rewardGold: 500,
    rewardTitle: "Magnate de las Indias",
  },
  {
    key: "mission_master_10",
    title: "Cumplidor",
    description: "Completa 10 misiones.",
    statKey: "lifetime_missions_completed",
    threshold: 10,
    rewardGold: 150,
    rewardTitle: "Mercenario de Confianza",
  },
  {
    key: "duelist_first",
    title: "Duelista",
    description: "Hunde a tu primer jugador rival.",
    statKey: "lifetime_players_sunk",
    threshold: 1,
    rewardGold: 50,
    rewardTitle: "Terror de los Mares",
  },
  {
    key: "sea_wolf_streak_7",
    title: "Lobo de Mar",
    description: "Entra al juego 7 días consecutivos.",
    statKey: "streak_count",
    threshold: 7,
    rewardGold: 100,
    rewardTitle: "Lobo de Mar",
  },
  // Phase 7 (fourth slice): the honest equivalent of the plan's "rare
  // drop" for defeating a weekend-event boss — no item/cosmetic system
  // exists, so a title plus a bigger gold bonus than any other achievement
  // is the reward.
  {
    key: "boss_slayer",
    title: "Verdugo de Jefes",
    description: "Hunde a tu primer barco Jefe en un evento de fin de semana.",
    statKey: "lifetime_bosses_sunk",
    threshold: 1,
    rewardGold: 300,
    rewardTitle: "Verdugo de los Mares",
  },
];

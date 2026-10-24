import type { BotKind } from "./types";

// Phase 5 missions. Only the 3 types that map onto systems that already
// exist: Caza (hunt bots), Escolta (protect a live merchant bot), and
// Exploración (sail within radius of a landmark). "Entrega", "Recompensa"
// and "Tesoro" from the plan's table need systems (multi-dock trade,
// bounty/reputation, treasure clues) that don't exist yet — deliberately
// skipped rather than faked.
export type MissionType = "caza" | "escolta" | "exploracion";

export interface CazaParams {
  // undefined means "any kind" — about half of generated offers filter by
  // kind, the rest accept either.
  botKind?: BotKind;
  count: number;
}

export interface EscoltaParams {
  escortBotId: string;
  surviveSeconds: number;
}

export interface ExploracionParams {
  x: number;
  y: number;
  radius: number;
}

export type MissionParams = CazaParams | EscoltaParams | ExploracionParams;

export interface MissionOffer {
  type: MissionType;
  params: MissionParams;
  // The progress goal: bot count for Caza, seconds survived for Escolta,
  // and 1 ("arrived") for Exploración.
  target: number;
  rewardGold: number;
  title: string;
  description: string;
}

function randomInt(rng: () => number, min: number, max: number): number {
  return Math.floor(min + rng() * (max - min + 1));
}

function randomRange(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

export const CAZA_COUNT_RANGE = [3, 8] as const;
export const ESCOLTA_SURVIVE_SECONDS_RANGE = [60, 180] as const;
export const EXPLORACION_RADIUS_BUFFER = 100;
export const EXPLORACION_REWARD_RANGE = [60, 140] as const;

function kindLabel(botKind: BotKind | undefined): string {
  if (botKind === "pirate") return "piratas";
  if (botKind === "merchant") return "mercantes";
  return "barcos";
}

export function generateCazaOffer(rng: () => number = Math.random, botKind?: BotKind): MissionOffer {
  const count = randomInt(rng, CAZA_COUNT_RANGE[0], CAZA_COUNT_RANGE[1]);
  const rewardGold = Math.round(count * randomRange(rng, 12, 18));
  const label = kindLabel(botKind);

  return {
    type: "caza",
    params: { botKind, count },
    target: count,
    rewardGold,
    title: `Caza: hundir ${count} ${label}`,
    description: `Hunde ${count} ${label} en mar abierto para cobrar la recompensa.`,
  };
}

export function generateEscoltaOffer(rng: () => number = Math.random, escortBotId: string): MissionOffer {
  const surviveSeconds = randomInt(
    rng,
    ESCOLTA_SURVIVE_SECONDS_RANGE[0],
    ESCOLTA_SURVIVE_SECONDS_RANGE[1]
  );
  const rewardGold = surviveSeconds + randomInt(rng, 30, 90);

  return {
    type: "escolta",
    params: { escortBotId, surviveSeconds },
    target: surviveSeconds,
    rewardGold,
    title: `Escolta: protege al mercante ${surviveSeconds}s`,
    description: `Mantén vivo al mercante asignado durante ${surviveSeconds} segundos. La misión falla si se hunde antes.`,
  };
}

export function generateExploracionOffer(
  rng: () => number = Math.random,
  landmark: { x: number; y: number; radius: number }
): MissionOffer {
  const radius = landmark.radius + EXPLORACION_RADIUS_BUFFER;
  const rewardGold = randomInt(rng, EXPLORACION_REWARD_RANGE[0], EXPLORACION_REWARD_RANGE[1]);

  return {
    type: "exploracion",
    params: { x: landmark.x, y: landmark.y, radius },
    target: 1,
    rewardGold,
    title: "Exploración: navega hasta la isla",
    description: `Navega hasta (${Math.round(landmark.x)}, ${Math.round(landmark.y)}) y entra en su radio.`,
  };
}

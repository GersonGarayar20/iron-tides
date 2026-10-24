// Phase 6 chat, four channels as of Phase 7 (first slice), no persistence
// beyond a reported message (see server/src/db/chat.ts's chat_reports
// table). "zone" and "global" used to be identical since the world was one
// single OceanRoom; now that OceanRoom is parameterized per region+channel,
// "zone" is scoped to the sender's own current room instance while "global"
// reaches every region+channel room in the process (see OceanRoom's
// deliverChatMessage and server/src/world/directory.ts).
export type ChatChannel = "zone" | "global" | "group" | "clan";

export interface ChatMessage {
  channel: ChatChannel;
  // Persistent player id (not the volatile session id), so a report logged
  // from this message always points at the right player even across
  // reconnects.
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
}

export const CHAT_MAX_MESSAGE_LENGTH = 200;

// Server-side cap: at most this many messages per player per window,
// enforced in OceanRoom regardless of whatever the client does — a client
// throttle alone is never trusted.
export const CHAT_RATE_LIMIT_MAX_MESSAGES = 8;
export const CHAT_RATE_LIMIT_WINDOW_SECONDS = 60;

// Deliberately tiny and literal: a straightforward wordlist + word-boundary
// match, no fuzzy/leetspeak detection, no ML. Mixed English/Spanish since
// the rest of the game's player-facing text is Spanish.
const PROFANITY_WORDLIST = [
  "fuck",
  "shit",
  "bitch",
  "asshole",
  "cabron",
  "mierda",
  "puta",
  "pendejo",
];

function escapeRegExp(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PROFANITY_PATTERN = new RegExp(`\\b(${PROFANITY_WORDLIST.map(escapeRegExp).join("|")})\\b`, "gi");

export function containsProfanity(text: string): boolean {
  return PROFANITY_PATTERN.test(text);
}

// Masks every matched word with asterisks of the same length rather than
// rejecting the whole message outright — "mask/block" per the plan, and
// masking keeps the rest of an otherwise-fine message readable.
export function filterProfanity(text: string): string {
  return text.replace(PROFANITY_PATTERN, (match) => "*".repeat(match.length));
}

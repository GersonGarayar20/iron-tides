import { pool } from "./pool";

// The one piece of chat that's persisted: a reported message, logged for a
// human to review later. No action is taken automatically — there is no
// moderation UI yet, this is purely an evidence log.
export async function insertChatReport(
  reporterId: string,
  reportedPlayerId: string,
  messageText: string
): Promise<void> {
  await pool.query(
    `INSERT INTO chat_reports (reporter_id, reported_player_id, message_text) VALUES ($1, $2, $3)`,
    [reporterId, reportedPlayerId, messageText]
  );
}

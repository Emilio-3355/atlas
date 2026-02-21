import { query } from '../config/database.js';
import type { PendingAction } from '../types/index.js';

export async function createPendingAction(
  toolName: string,
  toolInput: Record<string, any>,
  previewText: string,
  conversationId: string,
): Promise<PendingAction> {
  const result = await query(
    `INSERT INTO pending_actions (tool_name, tool_input, preview_text, conversation_id)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [toolName, JSON.stringify(toolInput), previewText, conversationId]
  );
  return mapRow(result.rows[0]);
}

export async function getPendingAction(id: string): Promise<PendingAction | null> {
  const result = await query('SELECT * FROM pending_actions WHERE id = $1', [id]);
  return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
}

export async function getLatestPendingAction(userPhone: string): Promise<PendingAction | null> {
  const result = await query(
    `SELECT pa.* FROM pending_actions pa
     JOIN conversations c ON pa.conversation_id = c.id
     WHERE c.user_phone = $1 AND pa.status = 'pending' AND pa.expires_at > NOW()
     ORDER BY pa.created_at DESC LIMIT 1`,
    [userPhone]
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
}

export async function resolveAction(id: string, status: string, result?: any): Promise<void> {
  await query(
    `UPDATE pending_actions SET status = $1, result = $2, resolved_at = NOW() WHERE id = $3`,
    [status, result ? JSON.stringify(result) : null, id]
  );
}

function mapRow(row: any): PendingAction {
  return {
    id: row.id,
    toolName: row.tool_name,
    toolInput: row.tool_input,
    previewText: row.preview_text,
    conversationId: row.conversation_id,
    status: row.status,
    twilioMessageSid: row.twilio_message_sid,
    result: row.result,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
  };
}

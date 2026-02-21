import { query } from '../config/database.js';

export async function logAudit(
  actionType: string,
  toolName?: string,
  inputSummary?: string,
  outputSummary?: string,
  success?: boolean,
  errorMessage?: string,
  approvalStatus?: string,
  conversationId?: string,
  durationMs?: number,
): Promise<void> {
  await query(
    `INSERT INTO audit_log (action_type, tool_name, input_summary, output_summary, success, error_message, approval_status, conversation_id, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [actionType, toolName, inputSummary, outputSummary, success, errorMessage, approvalStatus, conversationId, durationMs]
  );
}

export async function getRecentAuditLogs(limit: number = 50) {
  const result = await query(
    'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1',
    [limit]
  );
  return result.rows;
}

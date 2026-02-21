import { query } from '../config/database.js';

export async function getApprovedCustomTools() {
  const result = await query(
    `SELECT * FROM tool_definitions WHERE status = 'active' ORDER BY usage_count DESC`
  );
  return result.rows;
}

export async function approveToolDefinition(id: string): Promise<void> {
  await query(
    `UPDATE tool_definitions SET status = 'active', approved_at = NOW() WHERE id = $1`,
    [id]
  );
}

export async function rejectToolDefinition(id: string): Promise<void> {
  await query(`UPDATE tool_definitions SET status = 'rejected' WHERE id = $1`, [id]);
}

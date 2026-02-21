import { query } from '../config/database.js';
import logger from '../utils/logger.js';

interface ToolUsageStats {
  toolName: string;
  totalUses: number;
  successCount: number;
  failureCount: number;
  avgDurationMs: number;
  successRate: number;
}

export async function getToolUsageStats(days: number = 30): Promise<ToolUsageStats[]> {
  const result = await query(
    `SELECT
       tool_name,
       COUNT(*) AS total_uses,
       SUM(CASE WHEN success THEN 1 ELSE 0 END) AS success_count,
       SUM(CASE WHEN NOT success THEN 1 ELSE 0 END) AS failure_count,
       AVG(duration_ms) AS avg_duration_ms
     FROM tool_usage
     WHERE created_at > NOW() - INTERVAL '1 day' * $1
     GROUP BY tool_name
     ORDER BY total_uses DESC`,
    [days]
  );

  return result.rows.map((r: any) => ({
    toolName: r.tool_name,
    totalUses: Number(r.total_uses),
    successCount: Number(r.success_count),
    failureCount: Number(r.failure_count),
    avgDurationMs: Math.round(Number(r.avg_duration_ms)),
    successRate: Number(r.success_count) / Number(r.total_uses),
  }));
}

export async function getRecentFailures(limit: number = 10): Promise<any[]> {
  const result = await query(
    `SELECT tool_name, input_summary, error_message, created_at
     FROM tool_usage
     WHERE NOT success AND created_at > NOW() - INTERVAL '7 days'
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

// Track a pattern: sequences of tools used together
export async function getToolSequences(days: number = 14): Promise<Record<string, number>> {
  const result = await query(
    `WITH tool_turns AS (
       SELECT conversation_id, tool_name, created_at,
              LAG(tool_name) OVER (PARTITION BY conversation_id ORDER BY created_at) AS prev_tool
       FROM tool_usage
       WHERE created_at > NOW() - INTERVAL '1 day' * $1
     )
     SELECT prev_tool || ' -> ' || tool_name AS sequence, COUNT(*) AS count
     FROM tool_turns
     WHERE prev_tool IS NOT NULL
     GROUP BY sequence
     ORDER BY count DESC
     LIMIT 20`,
    [days]
  );

  const sequences: Record<string, number> = {};
  for (const r of result.rows) {
    sequences[r.sequence] = Number(r.count);
  }
  return sequences;
}

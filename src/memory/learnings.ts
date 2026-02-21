import crypto from 'crypto';
import { query } from '../config/database.js';
import type { Learning, LearningOutcome } from '../types/index.js';

export async function recordLearning(
  taskDescription: string,
  approach: string,
  outcome: LearningOutcome,
  reflection?: string,
  resolution?: string,
  toolName?: string,
): Promise<Learning> {
  const patternHash = crypto
    .createHash('sha256')
    .update(`${taskDescription}:${approach}`)
    .digest('hex')
    .slice(0, 16);

  // Check if similar pattern exists
  const existing = await query(
    'SELECT id, pattern_count FROM learnings WHERE pattern_hash = $1',
    [patternHash]
  );

  if (existing.rows.length > 0) {
    // Increment pattern count
    const result = await query(
      `UPDATE learnings SET pattern_count = pattern_count + 1, outcome = $2,
       reflection = COALESCE($3, reflection), resolution = COALESCE($4, resolution),
       resolved_at = CASE WHEN $2 = 'success' THEN NOW() ELSE resolved_at END
       WHERE id = $5 RETURNING *`,
      [outcome, reflection, resolution, existing.rows[0].id]
    );
    return mapRow(result.rows[0]);
  }

  const result = await query(
    `INSERT INTO learnings (task_description, approach, outcome, reflection, resolution, tool_name, pattern_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [taskDescription, approach, outcome, reflection || null, resolution || null, toolName || null, patternHash]
  );

  return mapRow(result.rows[0]);
}

export async function findRelevantLearnings(taskDescription: string, limit: number = 3): Promise<Learning[]> {
  const result = await query(
    `SELECT *, similarity(task_description, $1) AS sim FROM learnings
     WHERE similarity(task_description, $1) > 0.1 OR task_description ILIKE $2
     ORDER BY sim DESC, pattern_count DESC
     LIMIT $3`,
    [taskDescription, `%${taskDescription.split(' ').slice(0, 3).join('%')}%`, limit]
  );

  return result.rows.map(mapRow);
}

export async function getFailurePatterns(toolName?: string, limit: number = 5): Promise<Learning[]> {
  const whereClause = toolName
    ? `WHERE outcome = 'failure' AND tool_name = $1`
    : `WHERE outcome = 'failure'`;
  const params = toolName ? [toolName, limit] : [limit];

  const result = await query(
    `SELECT * FROM learnings ${whereClause}
     ORDER BY pattern_count DESC, created_at DESC
     LIMIT $${params.length}`,
    params
  );

  return result.rows.map(mapRow);
}

function mapRow(row: any): Learning {
  return {
    id: row.id,
    taskDescription: row.task_description,
    approach: row.approach,
    outcome: row.outcome,
    reflection: row.reflection,
    resolution: row.resolution,
    toolName: row.tool_name,
    patternHash: row.pattern_hash,
    patternCount: row.pattern_count,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

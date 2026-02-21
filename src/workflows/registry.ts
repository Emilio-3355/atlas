import { query } from '../config/database.js';
import type { WorkflowDefinition } from '../types/index.js';
import logger from '../utils/logger.js';

export async function getWorkflow(name: string): Promise<WorkflowDefinition | null> {
  const result = await query(
    `SELECT * FROM workflow_definitions WHERE name = $1 AND status = 'active'`,
    [name]
  );
  if (result.rows.length === 0) return null;
  return mapRow(result.rows[0]);
}

export async function findWorkflowByTrigger(text: string): Promise<WorkflowDefinition | null> {
  const result = await query(
    `SELECT * FROM workflow_definitions
     WHERE status = 'active' AND trigger_pattern IS NOT NULL
     AND $1 ILIKE '%' || trigger_pattern || '%'
     ORDER BY usage_count DESC LIMIT 1`,
    [text]
  );
  if (result.rows.length === 0) return null;
  return mapRow(result.rows[0]);
}

export async function getAllWorkflows(): Promise<WorkflowDefinition[]> {
  const result = await query(
    `SELECT * FROM workflow_definitions WHERE status IN ('active', 'proposed') ORDER BY created_at DESC`
  );
  return result.rows.map(mapRow);
}

export async function incrementWorkflowUsage(id: string): Promise<void> {
  await query('UPDATE workflow_definitions SET usage_count = usage_count + 1 WHERE id = $1', [id]);
}

function mapRow(row: any): WorkflowDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    triggerPattern: row.trigger_pattern,
    steps: row.steps,
    status: row.status,
    usageCount: row.usage_count,
    createdAt: row.created_at,
  };
}

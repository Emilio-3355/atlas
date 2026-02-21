import { query } from '../config/database.js';
import type { ScheduledTask } from '../types/index.js';

export async function getScheduledTask(id: string): Promise<ScheduledTask | null> {
  const result = await query('SELECT * FROM scheduled_tasks WHERE id = $1', [id]);
  return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
}

export async function getActiveTasks(): Promise<ScheduledTask[]> {
  const result = await query(
    `SELECT * FROM scheduled_tasks WHERE status = 'active' ORDER BY next_run_at`
  );
  return result.rows.map(mapRow);
}

export async function cancelTask(id: string): Promise<void> {
  await query(`UPDATE scheduled_tasks SET status = 'cancelled' WHERE id = $1`, [id]);
}

function mapRow(row: any): ScheduledTask {
  return {
    id: row.id,
    taskType: row.task_type,
    content: row.content,
    scheduleType: row.schedule_type,
    scheduleValue: row.schedule_value,
    timezone: row.timezone,
    delivery: row.delivery,
    status: row.status,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    runCount: row.run_count,
    metadata: row.metadata || {},
    createdAt: row.created_at,
  };
}

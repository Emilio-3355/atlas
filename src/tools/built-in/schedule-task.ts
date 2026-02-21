import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { query } from '../../config/database.js';
import logger from '../../utils/logger.js';

export const scheduleTaskTool: ToolDefinition = {
  name: 'schedule_task',
  description: 'Self-schedule a future task. Atlas can schedule itself to do something later — check prices, send a follow-up, generate a report, etc.',
  category: 'action',
  requiresApproval: true,
  inputSchema: {
    type: 'object' as const,
    properties: {
      taskType: { type: 'string', description: 'Type of task (e.g., "price_check", "follow_up", "report")' },
      content: { type: 'string', description: 'What to do when the task fires' },
      scheduleType: { type: 'string', enum: ['one_shot', 'recurring', 'interval'], description: 'Schedule type' },
      scheduleValue: {
        type: 'string',
        description: 'ISO timestamp for one_shot, cron expression for recurring, ms interval for interval',
      },
      delivery: {
        type: 'string',
        enum: ['whatsapp', 'internal', 'conditional'],
        description: 'How to deliver results (default: whatsapp)',
      },
    },
    required: ['taskType', 'content', 'scheduleType', 'scheduleValue'],
  },
  enabled: true,
  builtIn: true,

  formatApproval(input: { taskType: string; content: string; scheduleType: string; scheduleValue: string; delivery?: string }) {
    let when: string;
    if (input.scheduleType === 'one_shot') {
      when = new Date(input.scheduleValue).toLocaleString('en-US', { timeZone: 'America/New_York' });
    } else if (input.scheduleType === 'recurring') {
      when = `Recurring: ${input.scheduleValue}`;
    } else {
      when = `Every ${Number(input.scheduleValue) / 1000 / 60} minutes`;
    }

    return `I'd like to schedule a task:\n\n*Type:* ${input.taskType}\n*What:* ${input.content}\n*When:* ${when}\n*Delivery:* ${input.delivery || 'whatsapp'}\n\nReply: *1* — Schedule  *2* — Edit  *3* — Cancel`;
  },

  async execute(
    input: { taskType: string; content: string; scheduleType: string; scheduleValue: string; delivery?: string },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    try {
      let nextRunAt: Date | null = null;
      if (input.scheduleType === 'one_shot') {
        nextRunAt = new Date(input.scheduleValue);
      }

      const result = await query(
        `INSERT INTO scheduled_tasks (task_type, content, schedule_type, schedule_value, delivery, next_run_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [input.taskType, input.content, input.scheduleType, input.scheduleValue, input.delivery || 'whatsapp', nextRunAt]
      );

      return {
        success: true,
        data: { id: result.rows[0].id, message: `Task scheduled: "${input.content}"` },
      };
    } catch (err) {
      logger.error('Schedule task error', { error: err });
      return { success: false, error: err instanceof Error ? err.message : 'Failed to schedule task' };
    }
  },
};

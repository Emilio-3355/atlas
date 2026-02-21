import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { query } from '../../config/database.js';
import logger from '../../utils/logger.js';

export const remindTool: ToolDefinition = {
  name: 'remind',
  description: 'Schedule a reminder for JP. Can be one-time ("remind me at 5pm") or recurring ("remind me every Monday at 9am"). Atlas will send the reminder via WhatsApp at the scheduled time.',
  category: 'action',
  requiresApproval: true,
  inputSchema: {
    type: 'object' as const,
    properties: {
      content: { type: 'string', description: 'The reminder message' },
      scheduleType: { type: 'string', enum: ['one_shot', 'recurring'], description: 'One-time or recurring' },
      scheduleValue: {
        type: 'string',
        description: 'ISO 8601 timestamp for one_shot (e.g., "2026-02-20T17:00:00-05:00") or cron expression for recurring (e.g., "0 9 * * 1" for every Monday 9am)',
      },
    },
    required: ['content', 'scheduleType', 'scheduleValue'],
  },
  enabled: true,
  builtIn: true,

  formatApproval(input: { content: string; scheduleType: string; scheduleValue: string }) {
    const when = input.scheduleType === 'one_shot'
      ? new Date(input.scheduleValue).toLocaleString('en-US', { timeZone: 'America/New_York' })
      : `Recurring: ${input.scheduleValue}`;

    return `I'd like to set a reminder:\n\n*Message:* ${input.content}\n*When:* ${when}\n\nReply: *1* — Set reminder  *2* — Edit  *3* — Cancel`;
  },

  async execute(
    input: { content: string; scheduleType: string; scheduleValue: string },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    try {
      const nextRunAt = input.scheduleType === 'one_shot'
        ? new Date(input.scheduleValue)
        : null; // Cron will calculate next run

      const result = await query(
        `INSERT INTO scheduled_tasks (task_type, content, schedule_type, schedule_value, next_run_at, delivery)
         VALUES ('reminder', $1, $2, $3, $4, 'whatsapp')
         RETURNING id`,
        [input.content, input.scheduleType, input.scheduleValue, nextRunAt]
      );

      return {
        success: true,
        data: {
          id: result.rows[0].id,
          message: `Reminder set: "${input.content}"`,
        },
      };
    } catch (err) {
      logger.error('Remind error', { error: err });
      return { success: false, error: err instanceof Error ? err.message : 'Failed to set reminder' };
    }
  },
};

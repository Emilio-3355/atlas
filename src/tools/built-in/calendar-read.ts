import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { getCalendarEvents } from '../../services/gmail.js';
import logger from '../../utils/logger.js';

export const calendarReadTool: ToolDefinition = {
  name: 'calendar_read',
  description: 'List upcoming Google Calendar events for a date range. Use to check JP\'s schedule, find free time, or answer "what do I have tomorrow?"',
  category: 'informational',
  requiresApproval: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      timeMin: { type: 'string', description: 'Start of date range (ISO 8601, e.g. "2026-02-20T00:00:00-05:00")' },
      timeMax: { type: 'string', description: 'End of date range (ISO 8601)' },
      maxResults: { type: 'number', description: 'Max events to return (default 10)' },
    },
    required: ['timeMin', 'timeMax'],
  },
  enabled: true,
  builtIn: true,

  async execute(input: { timeMin: string; timeMax: string; maxResults?: number }, ctx: ToolContext): Promise<ToolResult> {
    try {
      const events = await getCalendarEvents(input.timeMin, input.timeMax, input.maxResults || 10);

      if (events.length === 0) {
        return { success: true, data: { events: [], formatted: 'No events found for this period.' } };
      }

      const formatted = events.map((e) => {
        const start = new Date(e.start).toLocaleString('en-US', {
          timeZone: 'America/New_York',
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        });
        return `• *${e.summary}*\n  ${start}${e.location ? `\n  📍 ${e.location}` : ''}`;
      }).join('\n\n');

      return { success: true, data: { events, formatted, count: events.length } };
    } catch (err) {
      logger.error('Calendar read error', { error: err });
      return { success: false, error: err instanceof Error ? err.message : 'Calendar read failed' };
    }
  },
};

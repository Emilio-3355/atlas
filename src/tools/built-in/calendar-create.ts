import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { createCalendarEvent } from '../../services/gmail.js';
import logger from '../../utils/logger.js';

export const calendarCreateTool: ToolDefinition = {
  name: 'calendar_create',
  description: 'Create or modify a Google Calendar event. Shows details for JP to approve before creating.',
  category: 'action',
  requiresApproval: true,
  inputSchema: {
    type: 'object' as const,
    properties: {
      summary: { type: 'string', description: 'Event title' },
      start: { type: 'string', description: 'Start time (ISO 8601 with timezone)' },
      end: { type: 'string', description: 'End time (ISO 8601 with timezone)' },
      description: { type: 'string', description: 'Event description/notes' },
      location: { type: 'string', description: 'Event location' },
    },
    required: ['summary', 'start', 'end'],
  },
  enabled: true,
  builtIn: true,

  formatApproval(input: { summary: string; start: string; end: string; description?: string; location?: string }) {
    const startStr = new Date(input.start).toLocaleString('en-US', { timeZone: 'America/New_York' });
    const endStr = new Date(input.end).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });

    let preview = `I'd like to create a calendar event:\n\n*${input.summary}*\n*When:* ${startStr} — ${endStr}`;
    if (input.location) preview += `\n*Where:* ${input.location}`;
    if (input.description) preview += `\n*Notes:* ${input.description}`;
    preview += '\n\nReply: *1* — Create  *2* — Edit  *3* — Cancel';
    return preview;
  },

  async execute(
    input: { summary: string; start: string; end: string; description?: string; location?: string },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    try {
      const eventId = await createCalendarEvent(
        input.summary,
        input.start,
        input.end,
        input.description,
        input.location,
      );

      return {
        success: true,
        data: { eventId, message: `Calendar event created: "${input.summary}"` },
      };
    } catch (err) {
      logger.error('Calendar create error', { error: err });
      return { success: false, error: err instanceof Error ? err.message : 'Failed to create event' };
    }
  },
};

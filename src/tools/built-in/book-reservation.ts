import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import logger from '../../utils/logger.js';

export const bookReservationTool: ToolDefinition = {
  name: 'book_reservation',
  description: 'Multi-step restaurant/venue reservation workflow. Searches for venues, compares options, and walks JP through the booking process with screenshots at every step.',
  category: 'action',
  requiresApproval: true,
  inputSchema: {
    type: 'object' as const,
    properties: {
      type: { type: 'string', enum: ['restaurant', 'hotel', 'activity', 'other'], description: 'Type of reservation' },
      query: { type: 'string', description: 'What to search for (e.g., "Italian restaurant in East Village")' },
      date: { type: 'string', description: 'Desired date (e.g., "Friday", "2026-02-21")' },
      time: { type: 'string', description: 'Desired time (e.g., "8pm", "20:00")' },
      partySize: { type: 'number', description: 'Number of people' },
      preferences: { type: 'string', description: 'Additional preferences (e.g., "outdoor seating", "quiet")' },
    },
    required: ['type', 'query', 'date', 'time', 'partySize'],
  },
  enabled: true,
  builtIn: true,

  formatApproval(input: { type: string; query: string; date: string; time: string; partySize: number; preferences?: string }) {
    let preview = `I'd like to find and book a ${input.type}:\n\n`;
    preview += `*Search:* ${input.query}\n`;
    preview += `*Date:* ${input.date}\n`;
    preview += `*Time:* ${input.time}\n`;
    preview += `*Party size:* ${input.partySize}`;
    if (input.preferences) preview += `\n*Preferences:* ${input.preferences}`;
    preview += '\n\nI\'ll search, compare options, and show you screenshots before booking anything.\n\nReply: *1* — Start searching  *2* — Edit  *3* — Cancel';
    return preview;
  },

  async execute(
    input: { type: string; query: string; date: string; time: string; partySize: number; preferences?: string },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    // This is a multi-step workflow that would normally trigger the workflow engine
    // For now, return instructions for the agent to use other tools
    return {
      success: true,
      data: {
        message: 'Reservation search started. Use web_search, browse, and screenshot tools to find and compare options.',
        steps: [
          `1. web_search("${input.query} ${input.date} reservation")`,
          '2. browse top 3 results',
          '3. screenshot each option',
          '4. Present options to JP',
          '5. After JP selects, browse booking page',
          '6. fill_form with booking details',
          '7. Screenshot confirmation',
        ],
        input,
      },
    };
  },
};

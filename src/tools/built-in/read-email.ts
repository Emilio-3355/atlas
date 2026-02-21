import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { searchEmails, getEmailBody } from '../../services/gmail.js';
import { tagContent, detectInjection } from '../../security/content-trust.js';
import logger from '../../utils/logger.js';

export const readEmailTool: ToolDefinition = {
  name: 'read_email',
  description: 'Search and read JP\'s Gmail inbox. Supports Gmail search syntax like "from:columbia subject:meeting" or "is:unread after:2026/02/01". Returns subjects, senders, and snippets.',
  category: 'informational',
  requiresApproval: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: 'Gmail search query (e.g., "from:columbia", "is:unread", "subject:invoice")' },
      maxResults: { type: 'number', description: 'Max results to return (default 5)' },
      readBody: { type: 'string', description: 'Message ID to read full body (from a previous search result)' },
    },
    required: ['query'],
  },
  enabled: true,
  builtIn: true,

  async execute(input: { query: string; maxResults?: number; readBody?: string }, ctx: ToolContext): Promise<ToolResult> {
    try {
      if (input.readBody) {
        const body = await getEmailBody(input.readBody);
        const injection = detectInjection(body);

        return {
          success: true,
          data: {
            body: tagContent(body, 'semi-trusted', 'gmail'),
            warning: injection.detected
              ? `⚠️ Potential injection attempt in email body: ${injection.patterns.join(', ')}`
              : undefined,
          },
        };
      }

      const emails = await searchEmails(input.query, input.maxResults || 5);

      const formatted = emails.map((e) =>
        `• *${e.subject}*\n  From: ${e.from}\n  ${e.date}\n  ${e.snippet}\n  _ID: ${e.id}_`
      ).join('\n\n');

      return {
        success: true,
        data: {
          emails: emails.map((e) => ({
            ...e,
            snippet: tagContent(e.snippet, 'semi-trusted', 'gmail'),
          })),
          formatted: tagContent(formatted, 'semi-trusted', 'gmail'),
          count: emails.length,
        },
      };
    } catch (err) {
      logger.error('Email read error', { error: err, query: input.query });
      return { success: false, error: err instanceof Error ? err.message : 'Email search failed' };
    }
  },
};

import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { getEnv } from '../../config/env.js';
import { tagContent } from '../../security/content-trust.js';
import logger from '../../utils/logger.js';

export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description: 'Search the web using Brave Search API. Returns titles, URLs, and snippets for the query. Use for finding current information, restaurants, events, prices, etc.',
  category: 'informational',
  requiresApproval: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: 'Search query' },
      count: { type: 'number', description: 'Number of results (default 5, max 10)' },
    },
    required: ['query'],
  },
  enabled: true,
  builtIn: true,

  async execute(input: { query: string; count?: number }, ctx: ToolContext): Promise<ToolResult> {
    const count = Math.min(input.count || 5, 10);

    try {
      const response = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(input.query)}&count=${count}`,
        {
          headers: {
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': getEnv().BRAVE_SEARCH_API_KEY,
          },
        }
      );

      if (!response.ok) {
        return { success: false, error: `Brave Search returned ${response.status}` };
      }

      const data = await response.json() as any;
      const results = (data.web?.results || []).map((r: any) => ({
        title: r.title,
        url: r.url,
        description: r.description,
      }));

      // Tag as untrusted external content
      const formatted = results.map((r: any) =>
        `• *${r.title}*\n  ${r.url}\n  ${tagContent(r.description, 'untrusted', 'brave_search')}`
      ).join('\n\n');

      return { success: true, data: { results, formatted, count: results.length } };
    } catch (err) {
      logger.error('Web search error', { error: err, query: input.query });
      return { success: false, error: err instanceof Error ? err.message : 'Search failed' };
    }
  },
};

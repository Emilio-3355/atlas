import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { searchFacts, getFactsByCategory } from '../../memory/structured.js';
import { hybridSearch } from '../../memory/semantic.js';
import logger from '../../utils/logger.js';

export const recallTool: ToolDefinition = {
  name: 'recall',
  description: 'Search Atlas\'s memory for stored facts, preferences, contacts, or any previously remembered information. Uses hybrid semantic + keyword search for best recall.',
  category: 'informational',
  requiresApproval: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: 'What to search for in memory' },
      category: { type: 'string', description: 'Optional category filter: preference, contact, schedule, booking, finance, health, general' },
    },
    required: ['query'],
  },
  enabled: true,
  builtIn: true,

  async execute(input: { query: string; category?: string }, ctx: ToolContext): Promise<ToolResult> {
    try {
      const [facts, semanticResults] = await Promise.all([
        input.category ? getFactsByCategory(input.category) : searchFacts(input.query, 5),
        hybridSearch(input.query, 5),
      ]);

      const results: string[] = [];

      if (facts.length > 0) {
        results.push('*Stored Facts:*');
        for (const f of facts) {
          results.push(`• [${f.category}] ${f.key}: ${f.value}`);
        }
      }

      if (semanticResults.length > 0) {
        results.push('\n*Related Memories:*');
        for (const m of semanticResults) {
          results.push(`• ${m.content} (relevance: ${(m.score * 100).toFixed(0)}%)`);
        }
      }

      if (results.length === 0) {
        return { success: true, data: { found: false, formatted: 'Nothing found in memory for this query.' } };
      }

      return {
        success: true,
        data: {
          found: true,
          facts,
          semanticResults,
          formatted: results.join('\n'),
        },
      };
    } catch (err) {
      logger.error('Recall error', { error: err, query: input.query });
      return { success: false, error: err instanceof Error ? err.message : 'Memory search failed' };
    }
  },
};

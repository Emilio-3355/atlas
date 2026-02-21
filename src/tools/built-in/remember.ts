import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { upsertFact } from '../../memory/structured.js';
import { storeSemanticMemory } from '../../memory/semantic.js';
import logger from '../../utils/logger.js';

export const rememberTool: ToolDefinition = {
  name: 'remember',
  description: 'Store a fact, preference, or piece of information in Atlas\'s memory. Use for things JP tells you to remember. Requires approval.',
  category: 'action',
  requiresApproval: true,
  inputSchema: {
    type: 'object' as const,
    properties: {
      category: {
        type: 'string',
        enum: ['preference', 'contact', 'schedule', 'booking', 'finance', 'health', 'general'],
        description: 'Category of the fact',
      },
      key: { type: 'string', description: 'Short identifier (e.g., "coffee_order", "mom_phone")' },
      value: { type: 'string', description: 'The information to store' },
      semantic: { type: 'boolean', description: 'Also store as semantic memory for similarity search (default true)' },
    },
    required: ['category', 'key', 'value'],
  },
  enabled: true,
  builtIn: true,

  formatApproval(input: { category: string; key: string; value: string }) {
    return `I'd like to remember this:\n\n*Category:* ${input.category}\n*Key:* ${input.key}\n*Value:* ${input.value}\n\nReply: *1* — Save  *2* — Edit  *3* — Cancel`;
  },

  async execute(input: { category: string; key: string; value: string; semantic?: boolean }, ctx: ToolContext): Promise<ToolResult> {
    try {
      const fact = await upsertFact(input.category, input.key, input.value, 'jp_told');

      // Also store as semantic memory for similarity search
      if (input.semantic !== false) {
        await storeSemanticMemory(
          `[${input.category}] ${input.key}: ${input.value}`,
          'jp_told',
          ctx.conversationId,
        );
      }

      return {
        success: true,
        data: { id: fact.id, message: `Remembered: ${input.key} = ${input.value}` },
      };
    } catch (err) {
      logger.error('Remember error', { error: err });
      return { success: false, error: err instanceof Error ? err.message : 'Failed to remember' };
    }
  },
};

import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { query } from '../../config/database.js';
import logger from '../../utils/logger.js';

export const proposeToolTool: ToolDefinition = {
  name: 'propose_tool',
  description: 'Meta-tool: propose a new tool capability for Atlas. Shows the proposal to JP for approval. Only use when you\'ve identified a recurring need that would benefit from a dedicated tool.',
  category: 'sensitive',
  requiresApproval: true,
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Tool name (snake_case)' },
      description: { type: 'string', description: 'What the tool does' },
      rationale: { type: 'string', description: 'Why this tool would be useful (cite patterns/frequency)' },
      inputSchema: { type: 'object', description: 'JSON Schema for the tool input' },
      implementationType: { type: 'string', enum: ['workflow', 'api_call', 'browser_action'], description: 'How the tool works' },
    },
    required: ['name', 'description', 'rationale', 'inputSchema', 'implementationType'],
  },
  enabled: true,
  builtIn: true,

  formatApproval(input: { name: string; description: string; rationale: string }) {
    return `I'd like to propose a new tool:\n\n*Name:* ${input.name}\n*Description:* ${input.description}\n*Why:* ${input.rationale}\n\nReply: *1* — Approve  *2* — Discuss  *3* — Reject`;
  },

  async execute(
    input: { name: string; description: string; rationale: string; inputSchema: Record<string, any>; implementationType: string },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    try {
      const result = await query(
        `INSERT INTO tool_definitions (name, description, input_schema, implementation_type, rationale, status)
         VALUES ($1, $2, $3, $4, $5, 'proposed')
         RETURNING id`,
        [input.name, input.description, JSON.stringify(input.inputSchema), input.implementationType, input.rationale]
      );

      return {
        success: true,
        data: { id: result.rows[0].id, message: `Tool proposed: "${input.name}". Awaiting JP's approval.` },
      };
    } catch (err) {
      logger.error('Propose tool error', { error: err });
      return { success: false, error: err instanceof Error ? err.message : 'Failed to propose tool' };
    }
  },
};

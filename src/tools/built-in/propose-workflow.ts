import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { query } from '../../config/database.js';
import logger from '../../utils/logger.js';

export const proposeWorkflowTool: ToolDefinition = {
  name: 'propose_workflow',
  description: 'Meta-tool: define a reusable multi-step workflow. Workflows chain tools together with approval gates and error handling. Shows the workflow to JP for approval.',
  category: 'sensitive',
  requiresApproval: true,
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Workflow name' },
      description: { type: 'string', description: 'What the workflow does' },
      triggerPattern: { type: 'string', description: 'Natural language pattern that activates this workflow' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            tool: { type: 'string', description: 'Tool to execute' },
            input: { type: 'object', description: 'Input for the tool (can reference $prev.result)' },
            requiresApproval: { type: 'boolean' },
            onError: { type: 'string', enum: ['stop', 'skip', 'retry', 'alternative'] },
            playByPlay: { type: 'string', description: 'Status message to send during this step' },
          },
          required: ['id', 'tool', 'input'],
        },
        description: 'Ordered steps in the workflow',
      },
    },
    required: ['name', 'description', 'steps'],
  },
  enabled: true,
  builtIn: true,

  formatApproval(input: { name: string; description: string; steps: any[] }) {
    const stepsPreview = input.steps.map((s, i) => `  ${i + 1}. ${s.tool}${s.requiresApproval ? ' ⚠️' : ''} — ${s.playByPlay || s.id}`).join('\n');
    return `I'd like to create a workflow:\n\n*Name:* ${input.name}\n*Description:* ${input.description}\n*Steps:*\n${stepsPreview}\n\n⚠️ = approval gate\n\nReply: *1* — Approve  *2* — Discuss  *3* — Reject`;
  },

  async execute(
    input: { name: string; description: string; triggerPattern?: string; steps: any[] },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    try {
      const result = await query(
        `INSERT INTO workflow_definitions (name, description, trigger_pattern, steps, status)
         VALUES ($1, $2, $3, $4, 'proposed')
         RETURNING id`,
        [input.name, input.description, input.triggerPattern || null, JSON.stringify(input.steps)]
      );

      return {
        success: true,
        data: { id: result.rows[0].id, message: `Workflow proposed: "${input.name}". Awaiting JP's approval.` },
      };
    } catch (err) {
      logger.error('Propose workflow error', { error: err });
      return { success: false, error: err instanceof Error ? err.message : 'Failed to propose workflow' };
    }
  },
};

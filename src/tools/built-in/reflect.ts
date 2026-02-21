import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { recordLearning } from '../../memory/learnings.js';
import type { LearningOutcome } from '../../types/index.js';
import logger from '../../utils/logger.js';

export const reflectTool: ToolDefinition = {
  name: 'reflect',
  description: 'Self-assessment tool: analyze what went well or wrong in a task, and store the learning for future reference. Use after completing a complex task or encountering an error.',
  category: 'informational',
  requiresApproval: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      task: { type: 'string', description: 'What task was attempted' },
      approach: { type: 'string', description: 'What approach was used' },
      outcome: { type: 'string', enum: ['success', 'failure', 'partial'], description: 'How it went' },
      reflection: { type: 'string', description: 'What went well/wrong and why' },
      resolution: { type: 'string', description: 'What to do differently next time' },
      toolName: { type: 'string', description: 'Which tool was involved (if any)' },
    },
    required: ['task', 'approach', 'outcome', 'reflection'],
  },
  enabled: true,
  builtIn: true,

  async execute(
    input: { task: string; approach: string; outcome: LearningOutcome; reflection: string; resolution?: string; toolName?: string },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    try {
      const learning = await recordLearning(
        input.task,
        input.approach,
        input.outcome,
        input.reflection,
        input.resolution,
        input.toolName,
      );

      return {
        success: true,
        data: {
          id: learning.id,
          patternCount: learning.patternCount,
          message: `Learning recorded: "${input.task}" → ${input.outcome}. ${learning.patternCount > 1 ? `This pattern has been seen ${learning.patternCount} times.` : 'New pattern.'}`,
        },
      };
    } catch (err) {
      logger.error('Reflect error', { error: err });
      return { success: false, error: err instanceof Error ? err.message : 'Failed to record learning' };
    }
  },
};

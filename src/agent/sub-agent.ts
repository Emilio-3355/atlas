import { callClaude, extractTextContent, extractToolUse } from './claude-client.js';
import { getToolRegistry } from '../tools/registry.js';
import { dashboardBus } from '../services/dashboard-events.js';
import logger from '../utils/logger.js';
import type { ToolContext, ReasoningDepth } from '../types/index.js';
import Anthropic from '@anthropic-ai/sdk';

const MAX_SUB_ITERATIONS = 5;
const MAX_CONCURRENT_AGENTS = 3;

let activeAgents = 0;

interface SubAgentTask {
  task: string;
  tools?: string[];  // Restrict to subset of tools
  depth?: ReasoningDepth;
  systemPrompt?: string;
}

interface SubAgentResult {
  success: boolean;
  output: string;
  toolsUsed: string[];
  iterations: number;
  durationMs: number;
}

/**
 * Run a lightweight sub-agent with isolated context.
 * The sub-agent gets a specific task, optional tool subset, and returns results.
 */
export async function runSubAgent(
  task: SubAgentTask,
  ctx: ToolContext,
): Promise<SubAgentResult> {
  if (activeAgents >= MAX_CONCURRENT_AGENTS) {
    return {
      success: false,
      output: `Cannot spawn sub-agent: ${activeAgents}/${MAX_CONCURRENT_AGENTS} agents already running`,
      toolsUsed: [],
      iterations: 0,
      durationMs: 0,
    };
  }

  activeAgents++;
  const startTime = Date.now();
  const toolsUsed: string[] = [];

  try {
    dashboardBus.publish({ type: 'sub_agent_start', data: { task: task.task.slice(0, 100) } });

    // Get available tools (optionally filtered)
    const registry = getToolRegistry();
    let availableTools = registry.getAll();

    if (task.tools && task.tools.length > 0) {
      availableTools = availableTools.filter(t => task.tools!.includes(t.name));
    }

    // Filter out sensitive tools for sub-agents (safety)
    availableTools = availableTools.filter(t => !t.requiresApproval);

    const claudeTools: Anthropic.Tool[] = availableTools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));

    const system = task.systemPrompt || `You are an Atlas sub-agent. Complete this task efficiently and return a concise result. You have access to informational tools only. Do not attempt actions that require approval.`;

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: task.task },
    ];

    let iterations = 0;
    const depth = task.depth || 'fast';

    while (iterations < MAX_SUB_ITERATIONS) {
      iterations++;

      const response = await callClaude({
        messages,
        system,
        tools: claudeTools.length > 0 ? claudeTools : undefined,
        depth,
      });

      const toolUse = extractToolUse(response.content);

      if (toolUse) {
        toolsUsed.push(toolUse.name);
        const tool = registry.get(toolUse.name);

        if (tool && !tool.requiresApproval) {
          const result = await tool.execute(toolUse.input as Record<string, any>, ctx);

          messages.push({ role: 'assistant', content: response.content });
          messages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: JSON.stringify(result.data || result.error || 'Done'),
            }],
          });
          continue;
        }
      }

      // No tool use or final response
      const textResponse = extractTextContent(response.content);

      dashboardBus.publish({ type: 'sub_agent_done', data: { task: task.task.slice(0, 100), iterations, toolsUsed } });

      return {
        success: true,
        output: textResponse || '(no output)',
        toolsUsed,
        iterations,
        durationMs: Date.now() - startTime,
      };
    }

    return {
      success: false,
      output: 'Sub-agent exceeded max iterations',
      toolsUsed,
      iterations,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    logger.error('Sub-agent failed', { error: err });
    return {
      success: false,
      output: err instanceof Error ? err.message : String(err),
      toolsUsed,
      iterations: 0,
      durationMs: Date.now() - startTime,
    };
  } finally {
    activeAgents--;
  }
}

/**
 * Run multiple sub-agents in parallel.
 * Max 3 concurrent.
 */
export async function runParallelSubAgents(
  tasks: SubAgentTask[],
  ctx: ToolContext,
): Promise<SubAgentResult[]> {
  // Limit to MAX_CONCURRENT_AGENTS
  const limited = tasks.slice(0, MAX_CONCURRENT_AGENTS);

  const results = await Promise.all(
    limited.map(task => runSubAgent(task, ctx))
  );

  return results;
}

import type { WorkflowStep, WorkflowDefinition, ToolContext, ToolResult } from '../types/index.js';
import { getToolRegistry } from '../tools/registry.js';
import { respondToUser } from '../agent/responder.js';
import { formatPlayByPlay } from '../utils/format.js';
import logger from '../utils/logger.js';

interface WorkflowState {
  currentStep: number;
  results: Map<string, ToolResult>;
  status: 'running' | 'paused' | 'completed' | 'failed';
}

export async function executeWorkflow(
  workflow: WorkflowDefinition,
  ctx: ToolContext,
  initialInput?: Record<string, any>,
): Promise<{ success: boolean; results: Record<string, ToolResult> }> {
  const state: WorkflowState = {
    currentStep: 0,
    results: new Map(),
    status: 'running',
  };

  const registry = getToolRegistry();

  for (let i = 0; i < workflow.steps.length; i++) {
    const step = workflow.steps[i] as WorkflowStep;
    state.currentStep = i;

    // Send play-by-play status if defined
    if (step.playByPlay) {
      const statusMsg = formatPlayByPlay(step.playByPlay, i + 1, workflow.steps.length);
      await respondToUser(ctx.userPhone, statusMsg, ctx.language, ctx.channel);
    }

    // Check if step requires approval — pause workflow
    if (step.requiresApproval) {
      state.status = 'paused';
      // The approval manager will resume the workflow
      logger.info('Workflow paused at approval gate', { workflow: workflow.name, step: step.id });
      return {
        success: true,
        results: Object.fromEntries(state.results),
      };
    }

    // Resolve input references ($prev.result, $step[id].result)
    const resolvedInput = resolveInputRefs(step.input, state.results, initialInput);

    // Execute the tool
    const tool = registry.get(step.tool);
    if (!tool) {
      if (step.onError === 'skip') continue;
      if (step.onError === 'stop') {
        state.status = 'failed';
        return { success: false, results: Object.fromEntries(state.results) };
      }
    }

    try {
      const result = await tool!.execute(resolvedInput, ctx);
      state.results.set(step.id, result);

      if (!result.success) {
        switch (step.onError) {
          case 'stop':
            state.status = 'failed';
            return { success: false, results: Object.fromEntries(state.results) };
          case 'skip':
            continue;
          case 'retry':
            // Simple retry once
            const retryResult = await tool!.execute(resolvedInput, ctx);
            state.results.set(step.id, retryResult);
            if (!retryResult.success) {
              state.status = 'failed';
              return { success: false, results: Object.fromEntries(state.results) };
            }
            break;
          case 'alternative':
            if (step.alternative) {
              const altTool = registry.get(step.alternative.tool);
              if (altTool) {
                const altResult = await altTool.execute(step.alternative.input, ctx);
                state.results.set(step.id, altResult);
              }
            }
            break;
        }
      }
    } catch (err) {
      logger.error('Workflow step error', { workflow: workflow.name, step: step.id, error: err });
      if (step.onError === 'stop') {
        state.status = 'failed';
        return { success: false, results: Object.fromEntries(state.results) };
      }
    }
  }

  state.status = 'completed';
  return { success: true, results: Object.fromEntries(state.results) };
}

function resolveInputRefs(
  input: Record<string, any>,
  results: Map<string, ToolResult>,
  initialInput?: Record<string, any>,
): Record<string, any> {
  const resolved: Record<string, any> = {};

  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') {
      if (value === '$prev.result') {
        // Get the last result
        const entries = Array.from(results.entries());
        const lastResult = entries[entries.length - 1]?.[1];
        resolved[key] = lastResult?.data;
      } else if (value.startsWith('$step[') && value.endsWith('].result')) {
        const stepId = value.slice(6, -8);
        resolved[key] = results.get(stepId)?.data;
      } else if (value.startsWith('$input.') && initialInput) {
        const inputKey = value.slice(7);
        resolved[key] = initialInput[inputKey];
      } else {
        resolved[key] = value;
      }
    } else {
      resolved[key] = value;
    }
  }

  return resolved;
}

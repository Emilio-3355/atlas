import { recordLearning, findRelevantLearnings, getFailurePatterns } from '../memory/learnings.js';
import type { LearningOutcome } from '../types/index.js';
import logger from '../utils/logger.js';

// Record a tool execution result as a learning
export async function learnFromExecution(
  toolName: string,
  input: Record<string, any>,
  success: boolean,
  error?: string,
): Promise<void> {
  if (success) return; // Only learn from failures (successes are tracked in observer)

  const taskDescription = `Execute ${toolName} with input: ${JSON.stringify(input).slice(0, 200)}`;
  const approach = `Direct execution of ${toolName}`;
  const outcome: LearningOutcome = 'failure';
  const reflection = error || 'Tool execution failed without error message';

  // Check if there's a similar failure pattern with a known resolution
  const similar = await findRelevantLearnings(taskDescription, 1);

  if (similar.length > 0 && similar[0].resolution) {
    logger.info('Found similar past failure with resolution', {
      tool: toolName,
      pastResolution: similar[0].resolution,
    });
  }

  await recordLearning(taskDescription, approach, outcome, reflection, undefined, toolName);
}

// After a successful retry, link the resolution to the original failure
export async function recordResolution(
  toolName: string,
  originalError: string,
  resolution: string,
): Promise<void> {
  const taskDescription = `Execute ${toolName} — recovered from: ${originalError.slice(0, 100)}`;
  await recordLearning(taskDescription, 'retry with fix', 'success', 'Resolved', resolution, toolName);
}

// Get advice for a tool that frequently fails
export async function getToolAdvice(toolName: string): Promise<string | null> {
  const failures = await getFailurePatterns(toolName, 3);

  if (failures.length === 0) return null;

  const resolutions = failures
    .filter((f) => f.resolution)
    .map((f) => f.resolution);

  if (resolutions.length === 0) return null;

  return `Known issues with ${toolName}:\n${resolutions.map((r) => `• ${r}`).join('\n')}`;
}

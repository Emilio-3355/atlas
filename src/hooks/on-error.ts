import type { OnErrorHook, HookContext } from './types.js';
import { getToolAdvice } from '../self-improvement/learning-engine.js';
import logger from '../utils/logger.js';

// Smart error handling with escalation
export const smartErrorHandler: OnErrorHook = async (error: Error, ctx: HookContext) => {
  const message = error.message.toLowerCase();

  // Transient errors — retry
  if (message.includes('timeout') || message.includes('econnreset') || message.includes('rate limit')) {
    logger.info('Transient error — will retry', { tool: ctx.toolName, error: error.message });
    return { retry: true };
  }

  // Check if we have past advice for this tool
  const advice = await getToolAdvice(ctx.toolName);
  if (advice) {
    return {
      retry: false,
      fallback: `I encountered an error with ${ctx.toolName}. ${advice}`,
    };
  }

  // Unknown error
  return {
    retry: false,
    fallback: `I encountered an error: ${error.message}. Let me try a different approach.`,
  };
};

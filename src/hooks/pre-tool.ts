import type { PreToolHook, HookContext, PreToolHookResult } from './types.js';
import logger from '../utils/logger.js';

// Validate tool arguments before execution
export const validateToolArgs: PreToolHook = async (ctx: HookContext): Promise<PreToolHookResult> => {
  // Block any tool that tries to execute shell commands (should never happen — Atlas has no shell tool)
  if (ctx.toolInput?.command || ctx.toolInput?.shell || ctx.toolInput?.exec) {
    logger.warn('Blocked shell execution attempt', { tool: ctx.toolName, input: ctx.toolInput });
    return { allowed: false, reason: 'Shell execution is not allowed' };
  }

  // Validate URLs don't point to internal infrastructure
  if (ctx.toolInput?.url) {
    const url = ctx.toolInput.url as string;
    if (url.includes('localhost') || url.includes('127.0.0.1') || url.includes('169.254') || url.includes('metadata.google')) {
      logger.warn('Blocked internal URL access', { tool: ctx.toolName, url });
      return { allowed: false, reason: 'Cannot access internal or metadata URLs' };
    }
  }

  return { allowed: true };
};

// Rate limit sensitive tools
const toolCallCounts = new Map<string, { count: number; windowStart: number }>();

export const rateLimitTools: PreToolHook = async (ctx: HookContext): Promise<PreToolHookResult> => {
  const limits: Record<string, number> = {
    send_email: 10,
    fill_form: 5,
    generate_image: 5,
    propose_tool: 3,
    propose_workflow: 3,
  };

  const limit = limits[ctx.toolName];
  if (!limit) return { allowed: true };

  const now = Date.now();
  const window = 3600_000; // 1 hour

  const entry = toolCallCounts.get(ctx.toolName) || { count: 0, windowStart: now };

  if (now - entry.windowStart > window) {
    entry.count = 0;
    entry.windowStart = now;
  }

  entry.count++;
  toolCallCounts.set(ctx.toolName, entry);

  if (entry.count > limit) {
    return { allowed: false, reason: `Rate limit: ${ctx.toolName} exceeded ${limit} calls/hour` };
  }

  return { allowed: true };
};

import type { PostToolHook, HookContext, PostToolHookResult } from './types.js';
import type { ToolResult } from '../types/index.js';
import { learnFromExecution } from '../self-improvement/learning-engine.js';
import { query } from '../config/database.js';
import logger from '../utils/logger.js';

// Log tool results and detect patterns
export const logToolResults: PostToolHook = async (ctx: HookContext, result: ToolResult): Promise<PostToolHookResult> => {
  // Record in audit log
  try {
    await query(
      `INSERT INTO audit_log (action_type, tool_name, input_summary, output_summary, success, error_message, conversation_id)
       VALUES ('tool_execution', $1, $2, $3, $4, $5, $6)`,
      [
        ctx.toolName,
        JSON.stringify(ctx.toolInput).slice(0, 500),
        JSON.stringify(result.data || {}).slice(0, 500),
        result.success,
        result.error || null,
        ctx.conversationId,
      ]
    );
  } catch (err) {
    // Non-critical
  }

  // Learn from failures
  if (!result.success) {
    await learnFromExecution(ctx.toolName, ctx.toolInput, false, result.error);
  }

  return {};
};

// Detect patterns in consecutive tool usage
export const detectPatterns: PostToolHook = async (ctx: HookContext, result: ToolResult): Promise<PostToolHookResult> => {
  // This is tracked automatically via tool_usage table
  // The crystallizer analyzes patterns periodically
  return {};
};

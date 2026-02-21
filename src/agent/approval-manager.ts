import { query } from '../config/database.js';
import { getToolRegistry } from '../tools/registry.js';
import { respondToUser } from './responder.js';
import { formatApprovalButtons } from '../utils/format.js';
import type { PendingAction, ToolContext } from '../types/index.js';
import logger from '../utils/logger.js';

export async function createApproval(
  toolName: string,
  toolInput: Record<string, any>,
  conversationId: string,
): Promise<PendingAction | null> {
  const registry = getToolRegistry();
  const tool = registry.get(toolName);

  if (!tool || !tool.formatApproval) return null;

  const previewText = tool.formatApproval(toolInput);

  const result = await query(
    `INSERT INTO pending_actions (tool_name, tool_input, preview_text, conversation_id)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [toolName, JSON.stringify(toolInput), previewText, conversationId]
  );

  const action = result.rows[0];
  logger.info('Approval created', { id: action.id, tool: toolName });

  return {
    id: action.id,
    toolName: action.tool_name,
    toolInput: action.tool_input,
    previewText: action.preview_text,
    conversationId: action.conversation_id,
    status: action.status,
    createdAt: action.created_at,
    expiresAt: action.expires_at,
  } as PendingAction;
}

export async function executeApproval(actionId: string, ctx: ToolContext): Promise<string> {
  const result = await query('SELECT * FROM pending_actions WHERE id = $1', [actionId]);
  if (result.rows.length === 0) return 'Action not found.';

  const action = result.rows[0];
  if (action.status !== 'pending') return `Action already ${action.status}.`;

  const registry = getToolRegistry();
  const tool = registry.get(action.tool_name);
  if (!tool) return `Tool ${action.tool_name} not found.`;

  try {
    const toolResult = await tool.execute(action.tool_input, ctx);

    await query(
      `UPDATE pending_actions SET status = 'executed', result = $1, resolved_at = NOW() WHERE id = $2`,
      [JSON.stringify(toolResult), actionId]
    );

    // Audit log
    await query(
      `INSERT INTO audit_log (action_type, tool_name, input_summary, output_summary, success, approval_status, conversation_id)
       VALUES ('approved_execution', $1, $2, $3, $4, 'approved', $5)`,
      [action.tool_name, JSON.stringify(action.tool_input).slice(0, 500), JSON.stringify(toolResult).slice(0, 500), toolResult.success, action.conversation_id]
    );

    return toolResult.success
      ? `Done! ${toolResult.data?.message || ''}`
      : `Failed: ${toolResult.error || 'Unknown error'}`;
  } catch (err) {
    logger.error('Approval execution error', { actionId, error: err });
    return `Error executing action: ${err instanceof Error ? err.message : 'Unknown error'}`;
  }
}

export async function denyApproval(actionId: string): Promise<void> {
  await query(
    `UPDATE pending_actions SET status = 'denied', resolved_at = NOW() WHERE id = $1`,
    [actionId]
  );
}

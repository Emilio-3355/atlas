import Anthropic from '@anthropic-ai/sdk';
import { callClaude, extractTextContent, extractToolUse } from './claude-client.js';
import { buildSystemPrompt } from './system-prompt.js';
import { determineDepth, escalateDepth } from './reasoner.js';
import { detectMessageLanguage, respondToUser } from './responder.js';
import { buildContext } from './context-engine.js';
import { getToolRegistry } from '../tools/registry.js';
import { shouldCompact, compactConversation } from '../memory/conversation.js';
import { detectCorrection, handleCorrection } from '../self-improvement/correction-detector.js';
import { detectStaleness, handleStalenessFromToolResult } from '../self-improvement/staleness-detector.js';
import { query } from '../config/database.js';
import { dashboardBus } from '../services/dashboard-events.js';
import logger from '../utils/logger.js';
import type { AgentContext, AgentResponse, ReasoningDepth, ToolContext, PendingAction, MessageChannel } from '../types/index.js';

const MAX_TOOL_ITERATIONS = 10;

export async function processMessage(phone: string, incomingMessage: string, channel: MessageChannel = 'whatsapp'): Promise<void> {
  const startTime = Date.now();

  // Check for pending approval responses
  const approvalResult = await checkApprovalResponse(phone, incomingMessage, channel);
  if (approvalResult) return;

  // Detect language
  const language = detectMessageLanguage(incomingMessage);

  // Get or create conversation
  const conversation = await getOrCreateConversation(phone, language);

  // Store incoming message
  await storeMessage(conversation.id, 'user', incomingMessage);

  // Dashboard event: message received
  dashboardBus.publish({ type: 'message_in', data: { phone, preview: incomingMessage.slice(0, 100), conversationId: conversation.id } });

  // Auto-detect corrections and outdated knowledge
  const correctionSignal = detectCorrection(incomingMessage);
  if (correctionSignal) {
    await handleCorrection(conversation.id, incomingMessage, correctionSignal);
    logger.debug('Correction detected', { type: correctionSignal.type, confidence: correctionSignal.confidence });
  }

  // Load recent messages for context
  const recentMessages = await getRecentMessages(conversation.id, 20);

  // Build context from memory + learnings
  const contextResult = await buildContext(incomingMessage);
  const relevantMemory = contextResult.memory;
  const relevantLearnings = contextResult.learnings;

  // Check if conversation needs compaction
  if (await shouldCompact(conversation.id)) {
    await compactConversation(conversation.id);
  }

  // Get pending actions
  const pendingActions = await getPendingActions(phone);

  // Determine reasoning depth
  const depth = determineDepth(incomingMessage);

  // Build context
  const ctx: AgentContext = {
    conversationId: conversation.id,
    userPhone: phone,
    language,
    channel,
    recentMessages: recentMessages.map((m) => ({
      role: m.role as any,
      content: m.content,
      toolName: m.tool_name,
      toolInput: m.tool_input,
    })),
    relevantMemory,
    relevantLearnings,
    pendingActions,
  };

  // Build messages for Claude
  const claudeMessages: Anthropic.MessageParam[] = recentMessages.map((m) => ({
    role: m.role === 'user' ? 'user' as const : 'assistant' as const,
    content: m.content,
  }));

  // Get available tools
  const registry = getToolRegistry();
  const availableTools = registry.getAll();

  // Build system prompt
  const systemPrompt = buildSystemPrompt({
    language,
    conversationSummary: conversation.summary || undefined,
    relevantMemory,
    relevantLearnings,
    pendingActions,
    availableTools,
    currentTime: new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
  });

  // Build Claude tool schemas
  const claudeTools: Anthropic.Tool[] = availableTools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));

  // ReAct loop
  let currentDepth: ReasoningDepth = depth;
  let iterations = 0;
  let currentMessages = [...claudeMessages];

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;

    const response = await callClaude({
      messages: currentMessages,
      system: systemPrompt,
      tools: claudeTools.length > 0 ? claudeTools : undefined,
      depth: currentDepth,
    });

    // Check for tool use
    const toolUseBlock = extractToolUse(response.content);

    if (toolUseBlock) {
      // Dashboard event: tool call
      dashboardBus.publish({ type: 'tool_call', data: { tool: toolUseBlock.name, input: toolUseBlock.input } });

      const toolCallStart = Date.now();
      // Execute tool
      const toolResult = await executeToolCall(
        toolUseBlock.name,
        toolUseBlock.input as Record<string, any>,
        { conversationId: conversation.id, userPhone: phone, language, channel },
      );

      // Dashboard event: tool result
      dashboardBus.publish({ type: 'tool_result', data: { tool: toolUseBlock.name, success: toolResult.success, durationMs: Date.now() - toolCallStart, error: toolResult.error } });

      // Log tool usage
      await logToolUsage(toolUseBlock.name, toolResult.success, Date.now() - startTime, conversation.id, toolResult.error);

      // Staleness detection: check if tool results contradict previous knowledge
      if (toolResult.success && toolResult.data) {
        await handleStalenessFromToolResult(
          toolUseBlock.name,
          toolResult.data,
          conversation.id,
        ).catch((err) => logger.debug('Staleness check skipped', { error: err }));
      }

      // If tool requires approval, handle the approval flow
      if (toolResult.requiresApproval && toolResult.approvalPreview) {
        dashboardBus.publish({ type: 'approval_created', data: { tool: toolUseBlock.name, preview: toolResult.approvalPreview?.slice(0, 100) } });
        await createPendingAction(
          toolUseBlock.name,
          toolUseBlock.input as Record<string, any>,
          toolResult.approvalPreview,
          conversation.id,
        );
        // Send approval request to JP
        await respondToUser(phone, toolResult.approvalPreview, language, channel);
        await storeMessage(conversation.id, 'assistant', toolResult.approvalPreview);
        return;
      }

      // Add tool use and result to conversation for next iteration
      currentMessages.push({
        role: 'assistant',
        content: response.content,
      });
      currentMessages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolUseBlock.id,
          content: JSON.stringify(toolResult.data || toolResult.error || 'Done'),
        }],
      });

      // Auto-escalate if tool chain is getting long
      if (iterations >= 5 && currentDepth === 'fast') {
        currentDepth = escalateDepth(currentDepth);
        logger.debug('Auto-escalating reasoning depth', { newDepth: currentDepth, iterations });
      }

      continue;
    }

    // No tool use — extract final text response
    const textResponse = extractTextContent(response.content);

    if (textResponse) {
      await respondToUser(phone, textResponse, language, channel);
      await storeMessage(conversation.id, 'assistant', textResponse);

      // Dashboard event: message sent
      dashboardBus.publish({ type: 'message_out', data: { phone, preview: textResponse.slice(0, 100), conversationId: conversation.id } });

      // Update conversation
      await query(
        'UPDATE conversations SET message_count = message_count + 2, updated_at = NOW(), language = $1 WHERE id = $2',
        [language, conversation.id]
      );

      logger.info('Message processed', {
        conversationId: conversation.id,
        depth: currentDepth,
        iterations,
        durationMs: Date.now() - startTime,
        tokensUsed: response.usage.inputTokens + response.usage.outputTokens,
      });
    }

    return;
  }

  // If we exceeded max iterations, send a fallback message
  const fallback = language === 'es'
    ? 'Perdón, esta tarea es más compleja de lo esperado. ¿Puedes reformular tu solicitud?'
    : 'Sorry, this task is more complex than expected. Could you rephrase your request?';
  await respondToUser(phone, fallback, language, channel);
}

// ===== Helper Functions =====

async function getOrCreateConversation(phone: string, language: string) {
  // Try to get active conversation (within last 2 hours)
  const existing = await query(
    `SELECT * FROM conversations WHERE user_phone = $1 AND status = 'active'
     AND updated_at > NOW() - INTERVAL '2 hours' ORDER BY updated_at DESC LIMIT 1`,
    [phone]
  );

  if (existing.rows.length > 0) return existing.rows[0];

  // Create new conversation
  const result = await query(
    'INSERT INTO conversations (user_phone, language) VALUES ($1, $2) RETURNING *',
    [phone, language]
  );
  return result.rows[0];
}

async function storeMessage(conversationId: string, role: string, content: string, toolName?: string, toolInput?: any) {
  await query(
    'INSERT INTO messages (conversation_id, role, content, tool_name, tool_input) VALUES ($1, $2, $3, $4, $5)',
    [conversationId, role, content, toolName || null, toolInput ? JSON.stringify(toolInput) : null]
  );
}

async function getRecentMessages(conversationId: string, limit: number = 20) {
  const result = await query(
    `SELECT role, content, tool_name, tool_input FROM messages
     WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [conversationId, limit]
  );
  return result.rows.reverse();
}

async function getRelevantMemory(_message: string): Promise<string> {
  // Phase 2 will implement semantic search
  try {
    const result = await query(
      `SELECT category, key, value FROM memory_facts
       WHERE (expires_at IS NULL OR expires_at > NOW())
       ORDER BY updated_at DESC LIMIT 10`
    );
    if (result.rows.length === 0) return '';
    return result.rows.map((r: any) => `[${r.category}] ${r.key}: ${r.value}`).join('\n');
  } catch {
    return '';
  }
}

async function getRelevantLearnings(_message: string): Promise<string> {
  // Phase 5 will implement pattern matching
  return '';
}

async function getPendingActions(phone: string): Promise<PendingAction[]> {
  try {
    const result = await query(
      `SELECT pa.* FROM pending_actions pa
       JOIN conversations c ON pa.conversation_id = c.id
       WHERE c.user_phone = $1 AND pa.status = 'pending' AND pa.expires_at > NOW()
       ORDER BY pa.created_at DESC`,
      [phone]
    );
    return result.rows.map((r: any) => ({
      id: r.id,
      toolName: r.tool_name,
      toolInput: r.tool_input,
      previewText: r.preview_text,
      conversationId: r.conversation_id,
      status: r.status,
      twilioMessageSid: r.twilio_message_sid,
      result: r.result,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      resolvedAt: r.resolved_at,
    }));
  } catch {
    return [];
  }
}

async function checkApprovalResponse(phone: string, message: string, channel: MessageChannel = 'whatsapp'): Promise<boolean> {
  const normalized = message.trim().toLowerCase();
  const isApproval = ['1', 'yes', 'send', 'approve', 'dale', 'sí', 'si', 'ok', 'okay'].includes(normalized);
  const isDenial = ['3', 'no', 'cancel', 'cancelar', 'nah', 'stop'].includes(normalized);
  const isEdit = normalized.startsWith('2') || normalized.startsWith('edit') || normalized.startsWith('cambiar');

  if (!isApproval && !isDenial && !isEdit) return false;

  // Find most recent pending action
  const result = await query(
    `SELECT pa.* FROM pending_actions pa
     JOIN conversations c ON pa.conversation_id = c.id
     WHERE c.user_phone = $1 AND pa.status = 'pending' AND pa.expires_at > NOW()
     ORDER BY pa.created_at DESC LIMIT 1`,
    [phone]
  );

  if (result.rows.length === 0) return false;

  const action = result.rows[0];

  if (isApproval) {
    // Execute the pending action
    const registry = getToolRegistry();
    const tool = registry.get(action.tool_name);
    if (tool) {
      const toolResult = await tool.execute(action.tool_input, {
        conversationId: action.conversation_id,
        userPhone: phone,
        language: 'en',
        channel,
      });

      await query(
        `UPDATE pending_actions SET status = 'executed', result = $1, resolved_at = NOW() WHERE id = $2`,
        [JSON.stringify(toolResult), action.id]
      );

      const confirmMsg = toolResult.success ? '✓ Done!' : `Failed: ${toolResult.error}`;
      await respondToUser(phone, confirmMsg, undefined, channel);
    }
    return true;
  }

  if (isDenial) {
    await query(`UPDATE pending_actions SET status = 'denied', resolved_at = NOW() WHERE id = $1`, [action.id]);
    await respondToUser(phone, '✗ Cancelled.', undefined, channel);
    return true;
  }

  if (isEdit) {
    await respondToUser(phone, 'What would you like to change? Send me the updated details.', undefined, channel);
    return true;
  }

  return false;
}

async function executeToolCall(toolName: string, input: Record<string, any>, ctx: ToolContext) {
  const registry = getToolRegistry();
  const tool = registry.get(toolName);

  if (!tool) {
    return { success: false, error: `Unknown tool: ${toolName}` };
  }

  if (!tool.enabled) {
    return { success: false, error: `Tool ${toolName} is disabled` };
  }

  // If tool requires approval, don't execute — return approval preview
  if (tool.requiresApproval && tool.formatApproval) {
    return {
      success: true,
      requiresApproval: true,
      approvalPreview: tool.formatApproval(input),
    };
  }

  try {
    return await tool.execute(input, ctx);
  } catch (err) {
    logger.error('Tool execution error', { tool: toolName, error: err });
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function createPendingAction(
  toolName: string,
  toolInput: Record<string, any>,
  previewText: string,
  conversationId: string,
) {
  await query(
    `INSERT INTO pending_actions (tool_name, tool_input, preview_text, conversation_id)
     VALUES ($1, $2, $3, $4)`,
    [toolName, JSON.stringify(toolInput), previewText, conversationId]
  );
}

async function logToolUsage(toolName: string, success: boolean, durationMs: number, conversationId: string, error?: string) {
  try {
    await query(
      `INSERT INTO tool_usage (tool_name, success, duration_ms, error_message, conversation_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [toolName, success, durationMs, error || null, conversationId]
    );
  } catch {
    // Non-critical — don't fail the main flow
  }
}

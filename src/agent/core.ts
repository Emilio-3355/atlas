import Anthropic from '@anthropic-ai/sdk';
import { callClaude, extractTextContent, extractToolUse, extractAllToolUse } from './claude-client.js';
import { buildSystemPrompt } from './system-prompt.js';
import { determineDepth, escalateDepth } from './reasoner.js';
import { detectMessageLanguage, respondToUser } from './responder.js';
import { buildContext } from './context-engine.js';
import { getToolRegistry } from '../tools/registry.js';
import { shouldCompact, compactConversation } from '../memory/conversation.js';
import { detectCorrection, handleCorrection } from '../self-improvement/correction-detector.js';
import { detectStaleness, handleStalenessFromToolResult } from '../self-improvement/staleness-detector.js';
import { sendTelegramTyping } from '../services/telegram.js';
import { recordToolChain } from '../self-improvement/foundry.js';
import { learnFromExecution } from '../self-improvement/learning-engine.js';
import { checkToolPolicy } from '../security/tool-policies.js';
import { upsertFact, getFact } from '../memory/structured.js';
import { storeSemanticMemory } from '../memory/semantic.js';
import { getEnv } from '../config/env.js';
import { query } from '../config/database.js';
import { dashboardBus } from '../services/dashboard-events.js';
import logger from '../utils/logger.js';
import { hookManager } from '../hooks/manager.js';
import type { AgentContext, AgentResponse, ReasoningDepth, ToolContext, PendingAction, MessageChannel, ImageAttachment } from '../types/index.js';

const MAX_TOOL_ITERATIONS = 10;

// ─── Token Cost Tracking ────────────────────────────────────────

// Anthropic pricing per million tokens (as of 2025)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-opus-4-6':   { input: 15, output: 75 },
  'claude-code-daemon': { input: 0, output: 0 },
};

function calculateCost(inputTokens: number, outputTokens: number, model: string): number {
  const p = MODEL_PRICING[model] || MODEL_PRICING['claude-sonnet-4-6'];
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

function formatCostFooter(inputTokens: number, outputTokens: number, cost: number, durationMs: number, model: string): string {
  const costStr = cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(3)}`;
  const totalTokens = inputTokens + outputTokens;
  const seconds = (durationMs / 1000).toFixed(1);
  const modelShort = model.includes('opus') ? 'opus' : model.includes('daemon') ? 'free' : 'sonnet';
  return `_⚡ ${totalTokens.toLocaleString()} tokens (${inputTokens.toLocaleString()}↑ ${outputTokens.toLocaleString()}↓) · ${costStr} · ${seconds}s · ${modelShort}_`;
}

/**
 * Normalize user phone to a canonical ID so ALL channels share one conversation.
 * WhatsApp uses raw phone, Telegram uses tg:chatId, Voice uses caller number.
 * For JP (the only user), all map to JP_PHONE_NUMBER.
 */
export function normalizeUserPhone(phone: string, channel: MessageChannel): string {
  const jpPhone = getEnv().JP_PHONE_NUMBER;

  // Telegram: map JP's authorized chat ID to his phone number
  if (channel === 'telegram') {
    const chatId = phone.replace(/^tg:/, '');
    const authorizedChat = getEnv().TELEGRAM_CHAT_ID;
    if (chatId === authorizedChat) {
      return jpPhone;
    }
  }

  // Voice: match last 10 digits to identify JP
  if (channel === 'voice') {
    const cleaned = phone.replace(/\D/g, '');
    const jpCleaned = jpPhone.replace(/\D/g, '');
    if (cleaned.length >= 10 && jpCleaned.length >= 10 && cleaned.slice(-10) === jpCleaned.slice(-10)) {
      return jpPhone;
    }
  }

  // WhatsApp/Slack: already uses phone/identifier directly
  return phone;
}

// Tool loop detection (inspired by OpenClaw's pattern)
const toolCallHistory: Map<string, Array<{ hash: string; ts: number }>> = new Map();

function hashToolCall(toolName: string, input: Record<string, any>): string {
  const sortedInput = JSON.stringify(input, Object.keys(input).sort());
  // Simple hash — good enough for loop detection
  let hash = 0;
  const str = `${toolName}:${sortedInput}`;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return String(hash);
}

function detectToolLoop(conversationId: string, toolName: string, input: Record<string, any>): { stuck: boolean; count: number } {
  const key = conversationId;
  const hash = hashToolCall(toolName, input);

  if (!toolCallHistory.has(key)) toolCallHistory.set(key, []);
  const history = toolCallHistory.get(key)!;
  history.push({ hash, ts: Date.now() });

  // Keep last 30 entries
  if (history.length > 30) history.splice(0, history.length - 30);

  const identicalCount = history.filter(h => h.hash === hash).length;
  return { stuck: identicalCount >= 3, count: identicalCount };
}

function clearToolLoopHistory(conversationId: string) {
  toolCallHistory.delete(conversationId);
}

/** Smart retry: modify tool input on retry to increase success chances */
function getRetryInput(toolName: string, input: Record<string, any>, error: string, attempt: number): Record<string, any> {
  if (toolName === 'web_search' && attempt > 0) {
    // Simplify query: remove quotes, take first 5 words
    return { ...input, query: (input.query || '').replace(/"/g, '').split(' ').slice(0, 5).join(' ') };
  }
  if (toolName === 'browse' && error.includes('timeout')) {
    return { ...input, waitUntil: 'domcontentloaded' }; // faster than networkidle
  }
  return input; // no modification for unknown tools
}

/** Truncate or summarize large tool results to prevent context overflow */
async function truncateToolResult(text: string, maxChars: number = 60000, toolName?: string): Promise<string> {
  if (text.length <= maxChars) return text;

  // For very large results, try summarizing with Claude instead of hard-truncating
  if (toolName) {
    try {
      const response = await callClaude({
        messages: [{ role: 'user', content: `Summarize this ${toolName} output. Preserve all data points, errors, URLs, names, and numbers exactly:\n\n${text.slice(0, 100000)}` }],
        system: 'Summarize precisely. Keep all facts, numbers, names, dates, URLs, errors.',
        depth: 'fast',
        maxTokens: 2048,
      });
      return `[Summarized — original was ${text.length} chars]\n${extractTextContent(response.content)}`;
    } catch {
      // Fall through to hard truncation
    }
  }

  // Fallback: smart truncation preserving tail
  const tail = text.slice(-2000);
  const hasImportantTail = /error|exception|total|summary|result|}\s*$/i.test(tail);

  if (hasImportantTail) {
    return text.slice(0, maxChars - 2200) + '\n...(truncated)...\n' + tail;
  }
  return text.slice(0, maxChars) + '\n...(truncated)';
}

export async function processMessage(phone: string, incomingMessage: string, channel: MessageChannel = 'whatsapp', images?: ImageAttachment[]): Promise<void> {
  try {
    await _processMessageInner(phone, incomingMessage, channel, images);
  } catch (err) {
    logger.error('Unhandled error in processMessage', { error: err, phone, channel });
    // Always send a fallback so the user isn't left hanging
    const fallback = '⚠️ Something went wrong processing your message. Please try again.';
    try {
      await respondToUser(phone, fallback, undefined, channel);
    } catch (sendErr) {
      logger.error('Failed to send error fallback', { error: sendErr, phone });
    }
  }
}

async function _processMessageInner(phone: string, incomingMessage: string, channel: MessageChannel, images?: ImageAttachment[]): Promise<void> {
  const startTime = Date.now();

  // Normalize user identity so ALL channels share one conversation
  const conversationPhone = normalizeUserPhone(phone, channel);

  // Check for pending approval responses
  const approvalResult = await checkApprovalResponse(conversationPhone, incomingMessage, channel);
  if (approvalResult) return;

  // Detect language
  const language = detectMessageLanguage(incomingMessage);

  // Get or create conversation (uses canonical phone — shared across channels)
  const conversation = await getOrCreateConversation(conversationPhone, language);

  // Store incoming message
  await storeMessage(conversation.id, 'user', incomingMessage);

  // Dashboard event: message received
  dashboardBus.publish({ type: 'message_in', data: { phone, preview: incomingMessage.slice(0, 100), conversationId: conversation.id } });

  // Auto-detect corrections and outdated knowledge — extract behavioral rules
  let correctionRule: string | null = null;
  const correctionSignal = detectCorrection(incomingMessage);
  if (correctionSignal) {
    correctionRule = await handleCorrection(conversation.id, incomingMessage, correctionSignal);
    logger.debug('Correction detected', { type: correctionSignal.type, confidence: correctionSignal.confidence, ruleExtracted: !!correctionRule });
  }

  // Load recent messages for context
  const recentMessages = await getRecentMessages(conversation.id, 40);

  // Build context from memory + learnings + behavioral rules + past conversations
  const contextResult = await buildContext(incomingMessage, conversationPhone);
  const relevantMemory = contextResult.memory;
  const relevantLearnings = contextResult.learnings;
  const behavioralRules = contextResult.behavioralRules;

  // Check if conversation needs compaction
  if (await shouldCompact(conversation.id)) {
    await compactConversation(conversation.id);
  }

  // Get pending actions
  const pendingActions = await getPendingActions(conversationPhone);

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

  // Build messages for Claude — sanitize to prevent API errors
  const claudeMessages: Anthropic.MessageParam[] = sanitizeMessages(
    recentMessages.map((m) => ({
      role: m.role === 'user' ? 'user' as const : 'assistant' as const,
      content: m.content,
    }))
  );

  // If images are attached, replace the last user message with multimodal content
  if (images && images.length > 0 && claudeMessages.length > 0) {
    const lastMsg = claudeMessages[claudeMessages.length - 1];
    if (lastMsg.role === 'user') {
      const textContent = typeof lastMsg.content === 'string' ? lastMsg.content : '';
      const contentBlocks: Anthropic.ContentBlockParam[] = [];

      // Add images first so Claude "sees" them before reading the text
      for (const img of images) {
        contentBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mediaType,
            data: img.base64,
          },
        });
      }

      // Then add the text
      if (textContent.trim()) {
        contentBlocks.push({ type: 'text', text: textContent });
      }

      claudeMessages[claudeMessages.length - 1] = {
        role: 'user',
        content: contentBlocks,
      };

      logger.info('Multimodal message constructed', { imageCount: images.length, textLength: textContent.length });
    }
  }

  // Get available tools
  const registry = getToolRegistry();
  const availableTools = registry.getAll();

  // Build system prompt (inject active correction rule + permanent behavioral rules)
  const systemPrompt = buildSystemPrompt({
    language,
    conversationSummary: conversation.summary || undefined,
    relevantMemory,
    relevantLearnings,
    behavioralRules: behavioralRules || undefined,
    pendingActions,
    availableTools,
    currentTime: new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
    activeCorrection: correctionRule || undefined,
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
  const toolsUsed: string[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let lastModel = '';

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;

    // Send typing indicator so user knows Atlas is working
    if (channel === 'telegram') {
      sendTelegramTyping(phone.replace(/^tg:/, '')).catch(() => {});
    }

    const response = await callClaude({
      messages: currentMessages,
      system: systemPrompt,
      tools: claudeTools.length > 0 ? claudeTools : undefined,
      depth: currentDepth,
    });

    // Accumulate token usage across all iterations
    totalInputTokens += response.usage.inputTokens;
    totalOutputTokens += response.usage.outputTokens;
    lastModel = response.model;

    // Check for tool use — handle ALL tool_use blocks in the response
    const allToolUseBlocks = extractAllToolUse(response.content);

    if (allToolUseBlocks.length > 0) {
      // Execute all tool calls and collect results
      const toolResults: Array<{ id: string; result: any }> = [];

      for (const toolUseBlock of allToolUseBlocks) {
        // Tool loop detection — prevent infinite cycles
        const loopCheck = detectToolLoop(conversation.id, toolUseBlock.name, toolUseBlock.input as Record<string, any>);
        if (loopCheck.stuck) {
          logger.warn('Tool loop detected — same call repeated 3+ times', { tool: toolUseBlock.name, count: loopCheck.count });
          toolResults.push({
            id: toolUseBlock.id,
            result: { success: false, error: `Tool loop detected: ${toolUseBlock.name} has been called ${loopCheck.count} times with identical arguments. Try a completely different approach or tool.` },
          });
          continue;
        }

        dashboardBus.publish({ type: 'tool_call', data: { tool: toolUseBlock.name, input: toolUseBlock.input } });
        toolsUsed.push(toolUseBlock.name);

        // Refresh typing indicator before tool execution (tools can take 30+ seconds)
        if (channel === 'telegram') {
          sendTelegramTyping(phone.replace(/^tg:/, '')).catch(() => {});
        }

        const toolCallStart = Date.now();
        const toolResult = await executeToolCall(
          toolUseBlock.name,
          toolUseBlock.input as Record<string, any>,
          { conversationId: conversation.id, userPhone: phone, language, channel },
        );

        dashboardBus.publish({ type: 'tool_result', data: { tool: toolUseBlock.name, success: toolResult.success, durationMs: Date.now() - toolCallStart, error: toolResult.error } });
        await logToolUsage(toolUseBlock.name, toolResult.success, Date.now() - startTime, conversation.id, toolResult.error);

        // Staleness detection
        if (toolResult.success && toolResult.data) {
          await handleStalenessFromToolResult(toolUseBlock.name, toolResult.data, conversation.id)
            .catch((err) => logger.debug('Staleness check skipped', { error: err }));
        }

        // If tool requires approval, handle it and return
        if (toolResult.requiresApproval && toolResult.approvalPreview) {
          dashboardBus.publish({ type: 'approval_created', data: { tool: toolUseBlock.name, preview: toolResult.approvalPreview?.slice(0, 100) } });
          await createPendingAction(toolUseBlock.name, toolUseBlock.input as Record<string, any>, toolResult.approvalPreview, conversation.id);
          await respondToUser(phone, toolResult.approvalPreview, language, channel);
          await storeMessage(conversation.id, 'assistant', toolResult.approvalPreview);
          return;
        }

        toolResults.push({
          id: toolUseBlock.id,
          result: toolResult,
        });
      }

      // Add assistant response (with all tool_use blocks) and ALL tool_results (truncated/summarized)
      currentMessages.push({
        role: 'assistant',
        content: response.content,
      });
      const truncatedResults = await Promise.all(
        toolResults.map(async (tr) => ({
          type: 'tool_result' as const,
          tool_use_id: tr.id,
          content: await truncateToolResult(
            JSON.stringify(tr.result.data || tr.result.error || 'Done'),
            60000,
            toolsUsed[toolResults.indexOf(tr)],
          ),
        }))
      );
      currentMessages.push({
        role: 'user',
        content: truncatedResults,
      });

      // Play-by-play: send brief status on 3rd+ tool iteration so user knows Atlas is working
      if (iterations === 3 && toolsUsed.length >= 3) {
        const statusMsg = language === 'es'
          ? `🔍 Trabajando en esto... (${toolsUsed.length} pasos completados)`
          : `🔍 Working on it... (${toolsUsed.length} steps done)`;
        respondToUser(phone, statusMsg, language, channel).catch(() => {});
      }

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
      // Append cost footer for text channels (not voice — would be spoken)
      const durationMs = Date.now() - startTime;
      const cost = calculateCost(totalInputTokens, totalOutputTokens, lastModel);
      const costFooter = formatCostFooter(totalInputTokens, totalOutputTokens, cost, durationMs, lastModel);
      const responseWithCost = channel === 'voice' ? textResponse : `${textResponse}\n\n${costFooter}`;

      await respondToUser(phone, responseWithCost, language, channel);
      await storeMessage(conversation.id, 'assistant', textResponse); // Store without cost footer

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
        durationMs,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cost: `$${cost.toFixed(4)}`,
        model: lastModel,
      });

      // Clean up tool loop history for this conversation
      clearToolLoopHistory(conversation.id);

      // Foundry: record multi-tool chains for crystallization analysis
      if (toolsUsed.length >= 2) {
        recordToolChain(
          toolsUsed,
          incomingMessage.slice(0, 200),
          textResponse.slice(0, 200),
          true,
          conversation.id,
        ).catch((err) => logger.debug('Foundry recording skipped', { error: err }));
      }

      // Auto-extract facts from user message (non-blocking)
      extractAndStoreFacts(incomingMessage, conversation.id)
        .catch((err) => logger.debug('Fact extraction skipped', { error: err }));
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

export async function getOrCreateConversation(phone: string, language: string) {
  // Try to get active conversation (within last 2 hours)
  const existing = await query(
    `SELECT * FROM conversations WHERE user_phone = $1 AND status = 'active'
     AND updated_at > NOW() - INTERVAL '2 hours' ORDER BY updated_at DESC LIMIT 1`,
    [phone]
  );

  if (existing.rows.length > 0) return existing.rows[0];

  // Old conversation expired — summarize stale ones in background
  summarizeStaleConversations(phone)
    .catch((err) => logger.debug('Stale conversation summarization skipped', { error: err }));

  // Create new conversation
  const result = await query(
    'INSERT INTO conversations (user_phone, language) VALUES ($1, $2) RETURNING *',
    [phone, language]
  );
  return result.rows[0];
}

export async function storeMessage(conversationId: string, role: string, content: string, toolName?: string, toolInput?: any) {
  await query(
    'INSERT INTO messages (conversation_id, role, content, tool_name, tool_input) VALUES ($1, $2, $3, $4, $5)',
    [conversationId, role, content, toolName || null, toolInput ? JSON.stringify(toolInput) : null]
  );
}

export async function getRecentMessages(conversationId: string, limit: number = 20) {
  const result = await query(
    `SELECT role, content, tool_name, tool_input FROM messages
     WHERE conversation_id = $1 AND (compacted IS NULL OR compacted = false)
     ORDER BY created_at DESC LIMIT $2`,
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
    // Execute the pending action through the full security pipeline (policy + hooks + retry)
    const toolResult = await executeToolCall(
      action.tool_name,
      action.tool_input,
      {
        conversationId: action.conversation_id,
        userPhone: phone,
        language: 'en',
        channel,
      },
    );

    await query(
      `UPDATE pending_actions SET status = 'executed', result = $1, resolved_at = NOW() WHERE id = $2`,
      [JSON.stringify(toolResult), action.id]
    );

    const confirmMsg = toolResult.success ? '✓ Done!' : `Failed: ${toolResult.error}`;
    await respondToUser(phone, confirmMsg, undefined, channel);
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

  // Security policy check (NemoClaw-inspired deny-by-default)
  const policyCheck = checkToolPolicy(toolName, input);
  if (!policyCheck.allowed) {
    logger.warn('Tool blocked by policy', { tool: toolName, reason: policyCheck.reason });
    return { success: false, error: policyCheck.reason || 'Blocked by security policy' };
  }

  // If tool requires approval, don't execute — return approval preview
  if (tool.requiresApproval && tool.formatApproval) {
    return {
      success: true,
      requiresApproval: true,
      approvalPreview: tool.formatApproval(input),
    };
  }

  // Run pre-tool hooks (can block execution or modify input)
  const hookCtx = { toolName, toolInput: input, ...ctx };
  const preResult = await hookManager.runPreToolHooks(hookCtx);
  if (!preResult.allowed) {
    return { success: false, error: `Blocked by hook: ${preResult.reason || 'no reason'}` };
  }

  const MAX_RETRIES = 2;
  let lastError: string = '';

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const retryInput = attempt === 0 ? preResult.input : getRetryInput(toolName, input, lastError, attempt);
      let result = await tool.execute(retryInput, ctx);

      // Run post-tool hooks (can modify result)
      result = await hookManager.runPostToolHooks(hookCtx, result);

      // Learn from failures (non-blocking)
      if (!result.success) {
        learnFromExecution(toolName, input, false, result.error).catch(() => {});
      }

      return result;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      logger.error('Tool execution error', { tool: toolName, error: err, attempt });

      // Run on-error hooks (can trigger retry)
      const errorResult = await hookManager.runOnErrorHooks(
        err instanceof Error ? err : new Error(String(err)),
        hookCtx,
      );

      if (errorResult.fallback) {
        return { success: true, data: errorResult.fallback };
      }

      // Only retry on transient errors (timeout, network, etc.)
      const isTransient = errorResult.retry === true ||
        /timeout|ECONNRESET|ENOTFOUND|ETIMEDOUT|socket hang up|network/i.test(lastError);

      if (isTransient && attempt < MAX_RETRIES) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 5000); // 1s, 2s
        logger.info('Retrying tool after transient error', { tool: toolName, attempt: attempt + 1, delayMs: delay });
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      // Non-transient or max retries exhausted
      learnFromExecution(toolName, input, false, lastError).catch(() => {});
      return { success: false, error: lastError };
    }
  }

  return { success: false, error: lastError };
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

/**
 * Sanitize message history to prevent Claude API errors:
 * 1. Ensure all content is plain text (strip any serialized tool_use blocks)
 * 2. Merge consecutive same-role messages
 * 3. Ensure first message is from user
 * 4. Ensure alternating user/assistant pattern
 */
export function sanitizeMessages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;

  const cleaned: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    // Ensure content is a plain string — strip any JSON-encoded content blocks
    let content: string;
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      // Extract text from content blocks, skip tool_use/tool_result blocks
      content = msg.content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text || '')
        .join('');
      if (!content) continue; // skip messages with no text content
    } else {
      continue;
    }

    // Skip empty messages
    if (!content.trim()) continue;

    // If content looks like a serialized JSON array of content blocks, extract text
    if (content.startsWith('[{') && content.includes('"type"')) {
      try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
          content = parsed
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text || '')
            .join('');
          if (!content.trim()) continue;
        }
      } catch {
        // Not JSON — use as-is
      }
    }

    const role = msg.role === 'user' ? 'user' as const : 'assistant' as const;

    // Merge consecutive same-role messages
    if (cleaned.length > 0 && cleaned[cleaned.length - 1].role === role) {
      const prev = cleaned[cleaned.length - 1];
      cleaned[cleaned.length - 1] = {
        role,
        content: `${prev.content}\n\n${content}`,
      };
    } else {
      cleaned.push({ role, content });
    }
  }

  // Ensure first message is from user
  while (cleaned.length > 0 && cleaned[0].role !== 'user') {
    cleaned.shift();
  }

  // Ensure last message is from user (Claude expects to respond to user)
  while (cleaned.length > 0 && cleaned[cleaned.length - 1].role !== 'user') {
    cleaned.pop();
  }

  return cleaned;
}

// ===== Auto Memory Extraction =====

const TRIVIAL_PATTERNS = /^(ok|okay|thanks|thank you|gracias|si|sí|no|yes|got it|cool|nice|lol|haha|k|👍|🙏)$/i;

/**
 * Auto-extract structured facts from user messages using a fast Claude call.
 * Skips trivial messages. Caps at 5 facts per message. Deduplicates before upserting.
 */
async function extractAndStoreFacts(userMessage: string, conversationId: string): Promise<void> {
  // Skip trivial messages
  const trimmed = userMessage.trim();
  if (trimmed.length < 15) return;
  if (TRIVIAL_PATTERNS.test(trimmed)) return;
  // Skip pure questions (likely not stating facts)
  if (/^(what|where|when|who|how|why|can you|could you|do you|is there|are there)\b/i.test(trimmed) && trimmed.endsWith('?')) return;

  try {
    const response = await callClaude({
      messages: [{
        role: 'user',
        content: `Extract factual information from this message that should be remembered about the user. Only extract concrete facts (preferences, contacts, dates, personal details, plans, opinions). Do NOT extract questions, commands, or greetings.

Message: "${trimmed}"

Respond ONLY with a JSON array (or empty array [] if no facts). Each item: {"category": "string", "key": "string", "value": "string"}
Categories: preference, contact, personal, schedule, location, work, finance, health, other
Keys should be specific and unique (e.g., "favorite_restaurant", "brother_name", "gym_schedule").
Max 5 facts. Be selective — only extract clearly stated information.`,
      }],
      system: 'You extract structured facts from messages. Respond with ONLY valid JSON, no explanation.',
      depth: 'fast',
      maxTokens: 512,
    });

    const text = extractTextContent(response.content).trim();
    // Parse JSON — handle markdown code blocks
    const jsonStr = text.replace(/^```json?\s*/, '').replace(/\s*```$/, '').trim();
    let facts: Array<{ category: string; key: string; value: string }>;
    try {
      facts = JSON.parse(jsonStr);
    } catch {
      logger.debug('Fact extraction: invalid JSON response', { text: text.slice(0, 200) });
      return;
    }

    if (!Array.isArray(facts) || facts.length === 0) return;

    // Cap at 5 facts
    const toProcess = facts.slice(0, 5);
    let stored = 0;

    for (const fact of toProcess) {
      if (!fact.category || !fact.key || !fact.value) continue;

      // Deduplication: skip if identical value already exists (Fix 5)
      const existing = await getFact(fact.category, fact.key);
      if (existing && existing.value === fact.value) continue;

      await upsertFact(
        fact.category,
        fact.key,
        fact.value,
        'auto_extracted',
        0.85, // lower confidence than explicit remember (1.0)
        { conversationId, sourceMessage: trimmed.slice(0, 200) },
      );

      // Also store as semantic memory for cross-conversation recall
      await storeSemanticMemory(
        `[${fact.category}] ${fact.key}: ${fact.value}`,
        'auto_extracted',
        conversationId,
        { factCategory: fact.category, factKey: fact.key },
      );

      stored++;
    }

    if (stored > 0) {
      logger.info('Auto-extracted facts', { count: stored, conversationId });
    }
  } catch (err) {
    logger.debug('Fact extraction failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Summarize stale conversations (>2h old, no summary, 4+ messages).
 * Runs in background when a new conversation is created.
 */
async function summarizeStaleConversations(phone: string): Promise<void> {
  try {
    const stale = await query(
      `SELECT id, language FROM conversations
       WHERE user_phone = $1 AND status = 'active'
       AND summary IS NULL
       AND updated_at < NOW() - INTERVAL '2 hours'
       AND message_count >= 4
       ORDER BY updated_at DESC LIMIT 3`,
      [phone]
    );

    if (stale.rows.length === 0) return;

    for (const conv of stale.rows) {
      try {
        // Get conversation messages (cap transcript at 8K chars)
        const msgs = await query(
          `SELECT role, content FROM messages
           WHERE conversation_id = $1 AND (compacted IS NULL OR compacted = false)
           ORDER BY created_at ASC LIMIT 50`,
          [conv.id]
        );

        if (msgs.rows.length < 4) continue;

        let transcript = msgs.rows
          .map((m: any) => `${m.role}: ${m.content}`)
          .join('\n');
        if (transcript.length > 8000) {
          transcript = transcript.slice(0, 8000) + '\n...(truncated)';
        }

        const response = await callClaude({
          messages: [{
            role: 'user',
            content: `Summarize this conversation between Atlas (assistant) and JP (user). Focus on: decisions made, facts learned about JP, action items, and key topics discussed.\n\n${transcript}`,
          }],
          system: 'Write a concise summary (2-4 sentences). Focus on facts, decisions, and outcomes — not greetings or pleasantries.',
          depth: 'fast',
          maxTokens: 512,
        });

        const summary = extractTextContent(response.content).trim();
        if (!summary) continue;

        // Update conversation with summary and close it
        await query(
          `UPDATE conversations SET summary = $1, status = 'closed', updated_at = NOW() WHERE id = $2`,
          [summary, conv.id]
        );

        // Store summary as semantic memory for cross-conversation recall
        await storeSemanticMemory(
          summary,
          'conversation_summary',
          conv.id,
          { conversationType: 'auto_summary' },
        );

        logger.info('Stale conversation summarized', { conversationId: conv.id, summaryLength: summary.length });
      } catch (err) {
        logger.debug('Failed to summarize stale conversation', { conversationId: conv.id, error: err });
      }
    }
  } catch (err) {
    logger.debug('Stale conversation scan failed', { error: err });
  }
}

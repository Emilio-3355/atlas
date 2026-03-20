import Anthropic from '@anthropic-ai/sdk';
import { query } from '../config/database.js';
import { callClaude, extractTextContent } from '../agent/claude-client.js';
import logger from '../utils/logger.js';

const COMPACTION_THRESHOLD = 80; // messages before compacting (was 40)
const KEEP_RECENT = 20; // messages to keep uncompacted (was 10)
const MODEL_CONTEXT_TOKENS = 200_000;
const COMPACT_CHAR_THRESHOLD = MODEL_CONTEXT_TOKENS * 0.40 * 4; // ~320K chars ≈ 40% of context

export async function getConversationMessages(conversationId: string, limit: number = 50) {
  const result = await query(
    `SELECT role, content, tool_name, tool_input, created_at FROM messages
     WHERE conversation_id = $1 AND (compacted IS NULL OR compacted = false)
     ORDER BY created_at DESC LIMIT $2`,
    [conversationId, limit]
  );
  return result.rows.reverse();
}

export async function shouldCompact(conversationId: string): Promise<boolean> {
  const result = await query(
    'SELECT message_count FROM conversations WHERE id = $1',
    [conversationId]
  );
  if (result.rows.length === 0) return false;

  // Message count threshold
  if (result.rows[0].message_count >= COMPACTION_THRESHOLD) return true;

  // Token-based threshold — compact when total content approaches 40% of model context
  const charResult = await query(
    `SELECT COALESCE(SUM(LENGTH(content)), 0) AS total_chars FROM messages
     WHERE conversation_id = $1 AND (compacted IS NULL OR compacted = false)`,
    [conversationId]
  );
  return Number(charResult.rows[0].total_chars) >= COMPACT_CHAR_THRESHOLD;
}

export async function compactConversation(conversationId: string): Promise<string> {
  // Get all non-compacted messages
  const messages = await getConversationMessages(conversationId, 200);

  if (messages.length <= KEEP_RECENT) return '';

  // Split into old (to compact) and recent (to keep)
  const oldMessages = messages.slice(0, messages.length - KEEP_RECENT);
  const recentMessages = messages.slice(messages.length - KEEP_RECENT);

  // Get existing summary
  const convResult = await query('SELECT summary FROM conversations WHERE id = $1', [conversationId]);
  const existingSummary = convResult.rows[0]?.summary || '';

  // Generate new summary using Claude
  const summaryPrompt = `Summarize the following conversation messages into a concise summary (max 500 words). Preserve key facts, decisions, preferences, and action items. If there's an existing summary, update it.

${existingSummary ? `Existing summary:\n${existingSummary}\n\n` : ''}New messages to incorporate:
${oldMessages.map((m) => `[${m.role}] ${m.content}`).join('\n')}`;

  const claudeMessages: Anthropic.MessageParam[] = [{ role: 'user', content: summaryPrompt }];

  const response = await callClaude({
    messages: claudeMessages,
    system: 'You are a conversation summarizer. Be concise and preserve important details.',
    depth: 'fast',
    maxTokens: 1500,
  });

  const summary = extractTextContent(response.content);

  // Update conversation with new summary
  await query(
    'UPDATE conversations SET summary = $1, updated_at = NOW() WHERE id = $2',
    [summary, conversationId]
  );

  // Soft-delete old messages (mark as compacted instead of deleting)
  const cutoffTime = recentMessages[0].created_at;
  await query(
    'UPDATE messages SET compacted = true WHERE conversation_id = $1 AND created_at < $2',
    [conversationId, cutoffTime]
  );

  logger.info('Conversation compacted (soft-delete)', {
    conversationId,
    messagesCompacted: oldMessages.length,
    messagesKept: recentMessages.length,
    summaryLength: summary.length,
  });

  return summary;
}

/**
 * Search past conversation summaries for cross-conversation recall.
 * Uses pg_trgm similarity matching on conversation summaries.
 */
export async function searchPastConversations(
  userPhone: string,
  searchText: string,
  limit: number = 3,
): Promise<Array<{ summary: string; updated_at: Date }>> {
  try {
    const result = await query(
      `SELECT summary, updated_at FROM conversations
       WHERE user_phone = $1 AND summary IS NOT NULL AND summary != ''
       AND similarity(summary, $2) > 0.1
       ORDER BY similarity(summary, $2) DESC LIMIT $3`,
      [userPhone, searchText, limit]
    );
    return result.rows;
  } catch (err) {
    // pg_trgm might not be available — fall back to ILIKE
    try {
      const fallback = await query(
        `SELECT summary, updated_at FROM conversations
         WHERE user_phone = $1 AND summary IS NOT NULL AND summary != ''
         AND summary ILIKE $2
         ORDER BY updated_at DESC LIMIT $3`,
        [userPhone, `%${searchText.slice(0, 100)}%`, limit]
      );
      return fallback.rows;
    } catch {
      logger.debug('Cross-conversation search unavailable', { error: err });
      return [];
    }
  }
}

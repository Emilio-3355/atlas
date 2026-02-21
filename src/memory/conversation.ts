import Anthropic from '@anthropic-ai/sdk';
import { query } from '../config/database.js';
import { callClaude, extractTextContent } from '../agent/claude-client.js';
import logger from '../utils/logger.js';

const COMPACTION_THRESHOLD = 40; // messages before compacting
const KEEP_RECENT = 10; // messages to keep uncompacted

export async function getConversationMessages(conversationId: string, limit: number = 50) {
  const result = await query(
    `SELECT role, content, tool_name, tool_input, created_at FROM messages
     WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2`,
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
  return result.rows[0].message_count >= COMPACTION_THRESHOLD;
}

export async function compactConversation(conversationId: string): Promise<string> {
  // Get all messages
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
    maxTokens: 800,
  });

  const summary = extractTextContent(response.content);

  // Update conversation with new summary
  await query(
    'UPDATE conversations SET summary = $1, updated_at = NOW() WHERE id = $2',
    [summary, conversationId]
  );

  // Delete old messages (keep recent)
  const cutoffTime = recentMessages[0].created_at;
  await query(
    'DELETE FROM messages WHERE conversation_id = $1 AND created_at < $2',
    [conversationId, cutoffTime]
  );

  logger.info('Conversation compacted', {
    conversationId,
    messagesRemoved: oldMessages.length,
    messagesKept: recentMessages.length,
    summaryLength: summary.length,
  });

  return summary;
}

import { query } from '../config/database.js';
import type { Message } from '../types/index.js';

export async function createMessage(
  conversationId: string,
  role: string,
  content: string,
  toolName?: string,
  toolInput?: Record<string, any>,
): Promise<Message> {
  const result = await query(
    'INSERT INTO messages (conversation_id, role, content, tool_name, tool_input) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [conversationId, role, content, toolName || null, toolInput ? JSON.stringify(toolInput) : null]
  );
  return mapRow(result.rows[0]);
}

export async function getMessages(conversationId: string, limit: number = 50): Promise<Message[]> {
  const result = await query(
    'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2',
    [conversationId, limit]
  );
  return result.rows.reverse().map(mapRow);
}

function mapRow(row: any): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    toolName: row.tool_name,
    toolInput: row.tool_input,
    metadata: row.metadata || {},
    createdAt: row.created_at,
  };
}

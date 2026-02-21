import { query } from '../config/database.js';
import type { Conversation } from '../types/index.js';

export async function getConversation(id: string): Promise<Conversation | null> {
  const result = await query('SELECT * FROM conversations WHERE id = $1', [id]);
  return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
}

export async function getActiveConversation(userPhone: string): Promise<Conversation | null> {
  const result = await query(
    `SELECT * FROM conversations WHERE user_phone = $1 AND status = 'active'
     ORDER BY updated_at DESC LIMIT 1`,
    [userPhone]
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
}

export async function createConversation(userPhone: string, language: string = 'en'): Promise<Conversation> {
  const result = await query(
    'INSERT INTO conversations (user_phone, language) VALUES ($1, $2) RETURNING *',
    [userPhone, language]
  );
  return mapRow(result.rows[0]);
}

export async function updateConversationSummary(id: string, summary: string): Promise<void> {
  await query(
    'UPDATE conversations SET summary = $1, updated_at = NOW() WHERE id = $2',
    [summary, id]
  );
}

function mapRow(row: any): Conversation {
  return {
    id: row.id,
    userPhone: row.user_phone,
    status: row.status,
    summary: row.summary,
    messageCount: row.message_count,
    language: row.language,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

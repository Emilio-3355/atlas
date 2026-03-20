import { query } from '../config/database.js';
import type { MemoryFact } from '../types/index.js';

export async function upsertFact(
  category: string,
  key: string,
  value: string,
  source: string = 'jp_told',
  confidence: number = 1.0,
  metadata: Record<string, any> = {},
  expiresAt?: Date,
): Promise<MemoryFact> {
  const result = await query(
    `INSERT INTO memory_facts (category, key, value, source, confidence, metadata, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (category, key)
     DO UPDATE SET value = $3, source = $4, confidence = $5, metadata = $6,
       expires_at = $7, updated_at = NOW()
     RETURNING *`,
    [category, key, value, source, confidence, JSON.stringify(metadata), expiresAt || null]
  );
  return mapRow(result.rows[0]);
}

export async function getFact(category: string, key: string): Promise<MemoryFact | null> {
  const result = await query(
    `SELECT * FROM memory_facts WHERE category = $1 AND key = $2
     AND (expires_at IS NULL OR expires_at > NOW())`,
    [category, key]
  );
  return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
}

export async function getFactsByCategory(category: string): Promise<MemoryFact[]> {
  const result = await query(
    `SELECT * FROM memory_facts WHERE category = $1
     AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY updated_at DESC`,
    [category]
  );
  return result.rows.map(mapRow);
}

export async function searchFacts(searchText: string, limit: number = 10): Promise<MemoryFact[]> {
  try {
    // Try pg_trgm similarity search (best quality)
    const result = await query(
      `SELECT *, similarity(value, $1) AS sim FROM memory_facts
       WHERE (expires_at IS NULL OR expires_at > NOW())
         AND (value ILIKE $2 OR key ILIKE $2 OR similarity(value, $1) > 0.1)
       ORDER BY sim DESC
       LIMIT $3`,
      [searchText, `%${searchText}%`, limit]
    );
    return result.rows.map(mapRow);
  } catch {
    // Fallback: ILIKE only (works without pg_trgm extension)
    const result = await query(
      `SELECT * FROM memory_facts
       WHERE (expires_at IS NULL OR expires_at > NOW())
         AND (value ILIKE $1 OR key ILIKE $1 OR category ILIKE $1)
       ORDER BY updated_at DESC
       LIMIT $2`,
      [`%${searchText}%`, limit]
    );
    return result.rows.map(mapRow);
  }
}

export async function deleteFact(category: string, key: string): Promise<boolean> {
  const result = await query(
    'DELETE FROM memory_facts WHERE category = $1 AND key = $2',
    [category, key]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getAllFacts(limit: number = 50): Promise<MemoryFact[]> {
  const result = await query(
    `SELECT * FROM memory_facts
     WHERE (expires_at IS NULL OR expires_at > NOW())
     ORDER BY updated_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows.map(mapRow);
}

function mapRow(row: any): MemoryFact {
  return {
    id: row.id,
    category: row.category,
    key: row.key,
    value: row.value,
    metadata: row.metadata || {},
    source: row.source,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

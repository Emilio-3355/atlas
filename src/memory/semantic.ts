import { query } from '../config/database.js';
import { generateEmbedding } from '../services/embedding.js';
import type { MemoryVector } from '../types/index.js';
import logger from '../utils/logger.js';

export async function storeSemanticMemory(
  content: string,
  source?: string,
  conversationId?: string,
  metadata: Record<string, any> = {},
): Promise<MemoryVector> {
  const embedding = await generateEmbedding(content);

  const result = await query(
    `INSERT INTO memory_vectors (content, embedding, metadata, source, conversation_id)
     VALUES ($1, $2::vector, $3, $4, $5)
     RETURNING *`,
    [content, `[${embedding.join(',')}]`, JSON.stringify(metadata), source || null, conversationId || null]
  );

  return mapRow(result.rows[0]);
}

export async function semanticSearch(
  queryText: string,
  limit: number = 5,
  minScore: number = 0.3,
): Promise<(MemoryVector & { score: number })[]> {
  const embedding = await generateEmbedding(queryText);

  const result = await query(
    `SELECT *, 1 - (embedding <=> $1::vector) AS score
     FROM memory_vectors
     WHERE 1 - (embedding <=> $1::vector) > $2
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [`[${embedding.join(',')}]`, minScore, limit]
  );

  return result.rows.map((row: any) => ({ ...mapRow(row), score: parseFloat(row.score) }));
}

export async function keywordSearch(
  searchText: string,
  limit: number = 5,
): Promise<(MemoryVector & { score: number })[]> {
  const result = await query(
    `SELECT *, similarity(content, $1) AS score
     FROM memory_vectors
     WHERE content ILIKE $2 OR similarity(content, $1) > 0.1
     ORDER BY score DESC
     LIMIT $3`,
    [searchText, `%${searchText}%`, limit]
  );

  return result.rows.map((row: any) => ({ ...mapRow(row), score: parseFloat(row.score) }));
}

// Hybrid search: combine semantic + keyword with weighted scoring
export async function hybridSearch(
  queryText: string,
  limit: number = 5,
): Promise<(MemoryVector & { score: number })[]> {
  const SEMANTIC_WEIGHT = 0.5;
  const KEYWORD_WEIGHT = 0.3;
  const DECAY_HALF_LIFE_DAYS = 30;

  const embedding = await generateEmbedding(queryText);

  const result = await query(
    `WITH semantic AS (
       SELECT id, content, metadata, source, conversation_id, created_at,
              1 - (embedding <=> $1::vector) AS sem_score
       FROM memory_vectors
     ),
     keyword AS (
       SELECT id, similarity(content, $2) AS kw_score
       FROM memory_vectors
       WHERE content ILIKE $3 OR similarity(content, $2) > 0.05
     )
     SELECT s.id, s.content, s.metadata, s.source, s.conversation_id, s.created_at,
            COALESCE(s.sem_score, 0) * $4 + COALESCE(k.kw_score, 0) * $5 AS raw_score,
            (COALESCE(s.sem_score, 0) * $4 + COALESCE(k.kw_score, 0) * $5)
              * EXP(-LN(2) / $6 * EXTRACT(EPOCH FROM (NOW() - s.created_at)) / 86400) AS score
     FROM semantic s
     LEFT JOIN keyword k ON s.id = k.id
     WHERE COALESCE(s.sem_score, 0) > 0.2 OR COALESCE(k.kw_score, 0) > 0.05
     ORDER BY score DESC
     LIMIT $7`,
    [
      `[${embedding.join(',')}]`,
      queryText,
      `%${queryText}%`,
      SEMANTIC_WEIGHT,
      KEYWORD_WEIGHT,
      DECAY_HALF_LIFE_DAYS,
      limit,
    ]
  );

  return result.rows.map((row: any) => ({ ...mapRow(row), score: parseFloat(row.score) }));
}

function mapRow(row: any): MemoryVector {
  return {
    id: row.id,
    content: row.content,
    metadata: row.metadata || {},
    source: row.source,
    conversationId: row.conversation_id,
    createdAt: row.created_at,
  };
}

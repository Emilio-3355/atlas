import { query } from '../config/database.js';
import { generateEmbedding } from '../services/embedding.js';
import type { MemoryVector } from '../types/index.js';
import logger from '../utils/logger.js';

// Track whether pgvector is available (checked once at first query)
let pgvectorAvailable: boolean | null = null;

async function checkPgvector(): Promise<boolean> {
  if (pgvectorAvailable !== null) return pgvectorAvailable;
  try {
    await query(`SELECT 1 FROM memory_vectors WHERE embedding_vec IS NOT NULL LIMIT 1`);
    pgvectorAvailable = true;
    logger.info('pgvector DB-side search available');
  } catch {
    pgvectorAvailable = false;
    logger.info('pgvector not available, using in-app cosine similarity');
  }
  return pgvectorAvailable;
}

// Cosine similarity computed in-app (fallback when pgvector not available)
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export async function storeSemanticMemory(
  content: string,
  source?: string,
  conversationId?: string,
  metadata: Record<string, any> = {},
): Promise<MemoryVector> {
  let embedding: number[];
  try {
    embedding = await generateEmbedding(content);
  } catch {
    // No embeddings available — store content WITHOUT vector (keyword-searchable only)
    const result = await query(
      `INSERT INTO memory_vectors (content, metadata, source, conversation_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [content, JSON.stringify(metadata), source || null, conversationId || null]
    );
    return mapRow(result.rows[0]);
  }

  // Store both JSON embedding (legacy) and native vector (for pgvector)
  const embeddingJson = JSON.stringify(embedding);
  const embeddingVec = `[${embedding.join(',')}]`;

  let result;
  try {
    result = await query(
      `INSERT INTO memory_vectors (content, embedding, embedding_vec, metadata, source, conversation_id)
       VALUES ($1, $2, $3::vector, $4, $5, $6)
       RETURNING *`,
      [content, embeddingJson, embeddingVec, JSON.stringify(metadata), source || null, conversationId || null]
    );
  } catch {
    // Fallback: store without embedding_vec if pgvector column doesn't exist
    result = await query(
      `INSERT INTO memory_vectors (content, embedding, metadata, source, conversation_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [content, embeddingJson, JSON.stringify(metadata), source || null, conversationId || null]
    );
  }

  return mapRow(result.rows[0]);
}

export async function semanticSearch(
  queryText: string,
  limit: number = 5,
  minScore: number = 0.3,
): Promise<(MemoryVector & { score: number })[]> {
  let embedding: number[];
  try {
    embedding = await generateEmbedding(queryText);
  } catch (err) {
    logger.warn('semanticSearch: embedding failed, falling back to keyword-only', {
      error: err instanceof Error ? err.message : String(err),
    });
    return keywordSearch(queryText, limit);
  }

  // Try pgvector DB-side search first
  if (await checkPgvector()) {
    try {
      const embeddingVec = `[${embedding.join(',')}]`;
      const result = await query(
        `SELECT *, 1 - (embedding_vec <=> $1::vector) AS score
         FROM memory_vectors WHERE embedding_vec IS NOT NULL
         ORDER BY embedding_vec <=> $1::vector LIMIT $2`,
        [embeddingVec, limit * 2]  // fetch 2x for MMR filtering downstream
      );
      return result.rows
        .map((row: any) => ({ ...mapRow(row), score: parseFloat(row.score) }))
        .filter((r) => r.score > minScore)
        .slice(0, limit);
    } catch (err) {
      logger.debug('pgvector search failed, falling back to in-app', { error: err });
    }
  }

  // Fallback: fetch all vectors and compute similarity in-app
  const result = await query(`SELECT * FROM memory_vectors`);

  const scored = result.rows
    .map((row: any) => {
      const stored = typeof row.embedding === 'string' ? JSON.parse(row.embedding) : (row.embedding || []);
      const score = cosineSimilarity(embedding, stored);
      return { ...mapRow(row), score };
    })
    .filter((r) => r.score > minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored;
}

export async function keywordSearch(
  searchText: string,
  limit: number = 5,
): Promise<(MemoryVector & { score: number })[]> {
  try {
    const result = await query(
      `SELECT *, similarity(content, $1) AS score
       FROM memory_vectors
       WHERE content ILIKE $2 OR similarity(content, $1) > 0.1
       ORDER BY score DESC
       LIMIT $3`,
      [searchText, `%${searchText}%`, limit]
    );
    return result.rows.map((row: any) => ({ ...mapRow(row), score: parseFloat(row.score) }));
  } catch {
    // Fallback without pg_trgm
    const result = await query(
      `SELECT *, 0.5 AS score FROM memory_vectors
       WHERE content ILIKE $1
       ORDER BY created_at DESC LIMIT $2`,
      [`%${searchText}%`, limit]
    );
    return result.rows.map((row: any) => ({ ...mapRow(row), score: 0.5 }));
  }
}

// Hybrid search: combine semantic + keyword with weighted scoring
export async function hybridSearch(
  queryText: string,
  limit: number = 5,
): Promise<(MemoryVector & { score: number })[]> {
  const SEMANTIC_WEIGHT = 0.5;
  const KEYWORD_WEIGHT = 0.3;
  const DECAY_HALF_LIFE_DAYS = 30;

  let embedding: number[];
  try {
    embedding = await generateEmbedding(queryText);
  } catch (err) {
    // OpenAI unavailable — fall back to keyword-only search
    logger.warn('hybridSearch: embedding failed, falling back to keyword-only', {
      error: err instanceof Error ? err.message : String(err),
    });
    return keywordSearch(queryText, limit);
  }

  // Get keyword matches from DB
  const kwResult = await query(
    `SELECT id, similarity(content, $1) AS kw_score
     FROM memory_vectors
     WHERE content ILIKE $2 OR similarity(content, $1) > 0.05`,
    [queryText, `%${queryText}%`]
  );
  const kwScores = new Map(kwResult.rows.map((r: any) => [r.id, parseFloat(r.kw_score)]));

  // Semantic scoring — try pgvector first
  let semScores: Map<string, number>;

  if (await checkPgvector()) {
    try {
      const embeddingVec = `[${embedding.join(',')}]`;
      const semResult = await query(
        `SELECT id, 1 - (embedding_vec <=> $1::vector) AS sem_score
         FROM memory_vectors WHERE embedding_vec IS NOT NULL
         ORDER BY embedding_vec <=> $1::vector LIMIT $2`,
        [embeddingVec, limit * 4]
      );
      semScores = new Map(semResult.rows.map((r: any) => [r.id, parseFloat(r.sem_score)]));

      // Fetch full rows for the matched IDs
      const ids = semResult.rows.map((r: any) => r.id);
      const kwIds = kwResult.rows.map((r: any) => r.id);
      const allIds = [...new Set([...ids, ...kwIds])];

      if (allIds.length === 0) return [];

      const fullResult = await query(
        `SELECT * FROM memory_vectors WHERE id = ANY($1)`,
        [allIds]
      );

      const now = Date.now();
      return fullResult.rows
        .map((row: any) => {
          const semScore = semScores.get(row.id) || 0;
          const kwScore = kwScores.get(row.id) || 0;
          if (semScore < 0.2 && kwScore < 0.05) return null;

          const rawScore = semScore * SEMANTIC_WEIGHT + kwScore * KEYWORD_WEIGHT;
          const ageDays = (now - new Date(row.created_at).getTime()) / 86400000;
          const decay = Math.exp(-Math.LN2 / DECAY_HALF_LIFE_DAYS * ageDays);
          return { ...mapRow(row), score: rawScore * decay };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit * 2); // Return 2x for MMR filtering in context-engine
    } catch (err) {
      logger.debug('pgvector hybrid search failed, falling back', { error: err });
    }
  }

  // Fallback: in-app cosine similarity
  const allResult = await query(`SELECT * FROM memory_vectors`);

  const now = Date.now();
  const scored = allResult.rows
    .map((row: any) => {
      const stored = typeof row.embedding === 'string' ? JSON.parse(row.embedding) : (row.embedding || []);
      const semScore = cosineSimilarity(embedding, stored);
      const kwScore = kwScores.get(row.id) || 0;

      if (semScore < 0.2 && kwScore < 0.05) return null;

      const rawScore = semScore * SEMANTIC_WEIGHT + kwScore * KEYWORD_WEIGHT;
      const ageDays = (now - new Date(row.created_at).getTime()) / 86400000;
      const decay = Math.exp(-Math.LN2 / DECAY_HALF_LIFE_DAYS * ageDays);
      const score = rawScore * decay;

      return { ...mapRow(row), score };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit * 2); // Return 2x for MMR filtering in context-engine

  return scored;
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

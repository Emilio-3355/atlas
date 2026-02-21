import { query } from '../config/database.js';
import { generateEmbedding } from '../services/embedding.js';
import type { MemoryVector } from '../types/index.js';
import logger from '../utils/logger.js';

// Cosine similarity computed in-app (pgvector not available on Railway standard Postgres)
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
  const embedding = await generateEmbedding(content);

  const result = await query(
    `INSERT INTO memory_vectors (content, embedding, metadata, source, conversation_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [content, JSON.stringify(embedding), JSON.stringify(metadata), source || null, conversationId || null]
  );

  return mapRow(result.rows[0]);
}

export async function semanticSearch(
  queryText: string,
  limit: number = 5,
  minScore: number = 0.3,
): Promise<(MemoryVector & { score: number })[]> {
  const embedding = await generateEmbedding(queryText);

  // Fetch all vectors and compute similarity in-app
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

  // Get keyword matches from DB
  const kwResult = await query(
    `SELECT id, similarity(content, $1) AS kw_score
     FROM memory_vectors
     WHERE content ILIKE $2 OR similarity(content, $1) > 0.05`,
    [queryText, `%${queryText}%`]
  );
  const kwScores = new Map(kwResult.rows.map((r: any) => [r.id, parseFloat(r.kw_score)]));

  // Get all vectors for semantic scoring
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
    .slice(0, limit);

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

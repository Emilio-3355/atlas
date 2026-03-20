/**
 * Embedding service — optional enhancement for semantic memory.
 *
 * Atlas memory works WITHOUT embeddings (structured facts + ILIKE/pg_trgm).
 * Embeddings are a BONUS for similarity search when an OpenAI key is available.
 * If no key is configured, all functions return gracefully — memory still works.
 */
import logger from '../utils/logger.js';

let openai: any = null;
let embeddingsAvailable: boolean | null = null;

async function getClient(): Promise<any | null> {
  if (embeddingsAvailable === false) return null;

  if (!openai) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || apiKey === 'PLACEHOLDER' || apiKey.length < 10) {
      embeddingsAvailable = false;
      logger.info('Embeddings disabled — no valid OPENAI_API_KEY. Memory works via keyword search.');
      return null;
    }
    try {
      const { default: OpenAI } = await import('openai');
      openai = new OpenAI({ apiKey });
      embeddingsAvailable = true;
    } catch {
      embeddingsAvailable = false;
      return null;
    }
  }
  return openai;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const client = await getClient();
  if (!client) {
    throw new Error('Embeddings not available (no OpenAI key)');
  }
  const response = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
    dimensions: 1536,
  });
  return response.data[0].embedding;
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const client = await getClient();
  if (!client) {
    throw new Error('Embeddings not available (no OpenAI key)');
  }
  const response = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: texts,
    dimensions: 1536,
  });

  return response.data
    .sort((a: any, b: any) => a.index - b.index)
    .map((d: any) => d.embedding);
}

/** Check if embeddings are available without throwing */
export function isEmbeddingAvailable(): boolean {
  if (embeddingsAvailable !== null) return embeddingsAvailable;
  const key = process.env.OPENAI_API_KEY;
  return !!key && key !== 'PLACEHOLDER' && key.length >= 10;
}

import OpenAI from 'openai';
import { getEnv } from '../config/env.js';
import logger from '../utils/logger.js';

let openai: OpenAI | null = null;

function getClient(): OpenAI {
  if (!openai) {
    openai = new OpenAI({ apiKey: getEnv().OPENAI_API_KEY });
  }
  return openai;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await getClient().embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
    dimensions: 1536,
  });
  return response.data[0].embedding;
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const response = await getClient().embeddings.create({
    model: 'text-embedding-3-small',
    input: texts,
    dimensions: 1536,
  });

  return response.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

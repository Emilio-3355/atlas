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

export async function generateImage(prompt: string, size: '1024x1024' | '1024x1792' | '1792x1024' = '1024x1024'): Promise<string> {
  const response = await getClient().images.generate({
    model: 'dall-e-3',
    prompt,
    n: 1,
    size,
    quality: 'standard',
  });

  const url = response.data?.[0]?.url;
  if (!url) throw new Error('No image URL returned');

  logger.info('Image generated', { prompt: prompt.slice(0, 50) });
  return url;
}

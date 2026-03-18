import OpenAI from 'openai';
import { getEnv } from '../config/env.js';
import logger from '../utils/logger.js';

let openaiClient: OpenAI | null = null;

function getClient(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: getEnv().OPENAI_API_KEY });
  }
  return openaiClient;
}

export type TTSVoice = 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';

/**
 * Generate speech audio from text using OpenAI TTS API.
 * Returns an audio Buffer (mp3 format).
 */
export async function textToSpeech(
  text: string,
  voice: TTSVoice = 'alloy',
): Promise<Buffer> {
  // Truncate very long text (TTS has limits)
  const truncated = text.slice(0, 4096);

  const client = getClient();

  const response = await client.audio.speech.create({
    model: 'tts-1',
    voice,
    input: truncated,
    response_format: 'mp3',
  });

  // Convert to Buffer
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  logger.debug('TTS generated', { textLength: truncated.length, audioBytes: buffer.length, voice });
  return buffer;
}

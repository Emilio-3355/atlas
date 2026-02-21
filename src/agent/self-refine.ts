import Anthropic from '@anthropic-ai/sdk';
import { callClaude, extractTextContent } from './claude-client.js';
import logger from '../utils/logger.js';

// Self-Refine: critique and improve response before sending to JP
export async function selfRefine(
  originalResponse: string,
  userMessage: string,
  language: string,
): Promise<string> {
  // Only self-refine for substantial responses (skip quick acknowledgments)
  if (originalResponse.length < 100) return originalResponse;

  const critiquePrompt = `You are a quality reviewer. Critique this response to a WhatsApp message.

User's message: "${userMessage}"
Language: ${language}

Response to critique:
"${originalResponse}"

Check:
1. Is the response accurate and complete?
2. Is it concise enough for WhatsApp? (under 500 chars ideal)
3. Does it match the user's language (${language})?
4. Are there any hallucinations or unsupported claims?
5. Is the tone appropriate (professional but warm)?

If the response is good, reply with just "APPROVED".
If it needs improvement, provide the improved version (just the improved text, nothing else).`;

  try {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: critiquePrompt }];

    const response = await callClaude({
      messages,
      system: 'You are a concise quality reviewer. Either approve or improve.',
      depth: 'fast',
      maxTokens: 600,
    });

    const critique = extractTextContent(response.content).trim();

    if (critique === 'APPROVED' || critique.startsWith('APPROVED')) {
      return originalResponse;
    }

    logger.debug('Self-refine improved response', {
      originalLength: originalResponse.length,
      improvedLength: critique.length,
    });

    return critique;
  } catch (err) {
    // If self-refine fails, return original (don't block the response)
    logger.error('Self-refine error', { error: err });
    return originalResponse;
  }
}

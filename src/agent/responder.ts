import { detectLanguage } from '../utils/language.js';
import { formatForWhatsApp } from '../utils/format.js';
import { sendWhatsAppMessage } from '../services/whatsapp.js';
import logger from '../utils/logger.js';

export async function respondToUser(
  phone: string,
  text: string,
  detectedLanguage?: string,
): Promise<void> {
  const chunks = formatForWhatsApp(text);

  for (const chunk of chunks) {
    await sendWhatsAppMessage(phone, chunk);
    // Small delay between chunks to preserve order
    if (chunks.length > 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  logger.debug('Responded to user', { phone, chunks: chunks.length, language: detectedLanguage });
}

export async function sendImage(
  phone: string,
  imageUrl: string,
  caption?: string,
): Promise<void> {
  const { sendWhatsAppImage } = await import('../services/whatsapp.js');
  await sendWhatsAppImage(phone, imageUrl, caption);
}

export function detectMessageLanguage(text: string): string {
  return detectLanguage(text);
}

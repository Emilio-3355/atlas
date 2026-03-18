import { detectLanguage } from '../utils/language.js';
import { formatForWhatsApp } from '../utils/format.js';
import { sendWhatsAppMessage, sendWhatsAppImage } from '../services/whatsapp.js';
import { sendTelegramMessage, sendTelegramImage } from '../services/telegram.js';
import logger from '../utils/logger.js';
import type { MessageChannel } from '../types/index.js';

export async function respondToUser(
  phone: string,
  text: string,
  detectedLanguage?: string,
  channel: MessageChannel = 'whatsapp',
): Promise<void> {
  if (channel === 'telegram') {
    const chatId = phone.replace(/^tg:/, '');
    await sendTelegramMessage(chatId, text);
  } else if (channel === 'slack') {
    // For Slack, the response is sent back through the Slack API
    const { sendSlackMessage } = await import('../services/slack.js');
    await sendSlackMessage(phone.replace(/^slack:/, ''), text);
  } else {
    const chunks = formatForWhatsApp(text);
    for (const chunk of chunks) {
      await sendWhatsAppMessage(phone, chunk);
      if (chunks.length > 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  logger.debug('Responded to user', { phone, channel, language: detectedLanguage });
}

export async function sendImage(
  phone: string,
  imageUrl: string,
  caption?: string,
  channel: MessageChannel = 'whatsapp',
): Promise<void> {
  if (channel === 'telegram') {
    const chatId = phone.replace(/^tg:/, '');
    await sendTelegramImage(chatId, imageUrl, caption);
  } else if (channel === 'slack') {
    const { sendSlackImage } = await import('../services/slack.js');
    await sendSlackImage(phone.replace(/^slack:/, ''), imageUrl, caption);
  } else {
    await sendWhatsAppImage(phone, imageUrl, caption);
  }
}

export function detectMessageLanguage(text: string): string {
  return detectLanguage(text);
}

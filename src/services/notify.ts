import { sendWhatsAppMessage } from './whatsapp.js';
import { sendTelegramMessage, isTelegramEnabled, getAuthorizedChatId } from './telegram.js';
import { getEnv } from '../config/env.js';
import logger from '../utils/logger.js';

/**
 * Send a system notification to JP via all active channels.
 * Used by schedulers, cron jobs, evolution, etc. — anything not in response to a user message.
 * Sends to WhatsApp always (primary), and Telegram if configured (secondary).
 */
export async function notifyUser(message: string): Promise<void> {
  const phone = getEnv().JP_PHONE_NUMBER;

  // Always send via WhatsApp (primary channel)
  try {
    await sendWhatsAppMessage(phone, message);
  } catch (err) {
    logger.error('Failed to notify via WhatsApp', { error: err });
  }

  // Also send via Telegram if configured
  if (isTelegramEnabled()) {
    try {
      const chatId = getAuthorizedChatId();
      if (chatId) {
        await sendTelegramMessage(chatId, message);
      }
    } catch (err) {
      logger.debug('Failed to notify via Telegram (non-fatal)', { error: err });
    }
  }
}

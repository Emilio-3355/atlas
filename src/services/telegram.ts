import { Bot } from 'grammy';
import { getEnv } from '../config/env.js';
import logger from '../utils/logger.js';

let bot: Bot | null = null;

export function getTelegramBot(): Bot | null {
  if (bot) return bot;

  const token = getEnv().TELEGRAM_BOT_TOKEN;
  if (!token) return null;

  bot = new Bot(token);
  return bot;
}

export function isTelegramEnabled(): boolean {
  return !!getEnv().TELEGRAM_BOT_TOKEN;
}

/** Get the authorized chat ID (JP only) */
export function getAuthorizedChatId(): string {
  return getEnv().TELEGRAM_CHAT_ID;
}

export async function sendTelegramMessage(chatId: string | number, text: string): Promise<number> {
  const b = getTelegramBot();
  if (!b) throw new Error('Telegram bot not initialized');

  try {
    // Convert WhatsApp formatting to Telegram MarkdownV2
    const formatted = formatForTelegram(text);
    const msg = await b.api.sendMessage(chatId, formatted, { parse_mode: 'HTML' });
    logger.debug('Telegram message sent', { chatId, messageId: msg.message_id });
    return msg.message_id;
  } catch (err) {
    // Fallback: send as plain text if formatting fails
    try {
      const msg = await b.api.sendMessage(chatId, text);
      return msg.message_id;
    } catch (fallbackErr) {
      logger.error('Failed to send Telegram message', { error: fallbackErr, chatId });
      throw fallbackErr;
    }
  }
}

export async function sendTelegramImage(chatId: string | number, imageUrl: string, caption?: string): Promise<number> {
  const b = getTelegramBot();
  if (!b) throw new Error('Telegram bot not initialized');

  try {
    const msg = await b.api.sendPhoto(chatId, imageUrl, { caption: caption || '' });
    return msg.message_id;
  } catch (err) {
    logger.error('Failed to send Telegram image', { error: err, chatId });
    throw err;
  }
}

/** Convert WhatsApp-style formatting to Telegram HTML */
function formatForTelegram(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*([^*]+)\*/g, '<b>$1</b>')       // *bold* → <b>bold</b>
    .replace(/_([^_]+)_/g, '<i>$1</i>')          // _italic_ → <i>italic</i>
    .replace(/~([^~]+)~/g, '<s>$1</s>')          // ~strike~ → <s>strike</s>
    .replace(/```([^`]+)```/g, '<code>$1</code>'); // ```code``` → <code>code</code>
}

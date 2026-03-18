import { Hono } from 'hono';
import { getTelegramBot, getAuthorizedChatId } from '../services/telegram.js';
import { messageQueue } from '../agent/message-queue.js';
import { rateLimiter } from '../security/rate-limiter.js';
import logger from '../utils/logger.js';

const telegramRouter = new Hono();

// Rate limit Telegram webhook
telegramRouter.use('*', rateLimiter({ maxRequests: 30, windowMs: 60_000, keyPrefix: 'rl:tg' }));

telegramRouter.post('/', async (c) => {
  try {
    const update = await c.req.json();

    // Only handle text messages
    const message = update.message;
    if (!message?.text) {
      return c.json({ ok: true });
    }

    const chatId = String(message.chat.id);
    const text = message.text;
    const from = message.from;

    logger.info('Incoming Telegram message', {
      chatId,
      from: from?.username || from?.first_name || 'unknown',
      length: text.length,
    });

    // Auth check — ONLY authorized chat ID can use Atlas
    const authorizedChatId = getAuthorizedChatId();
    if (chatId !== authorizedChatId) {
      logger.warn('Blocked unauthorized Telegram message', { chatId, authorized: authorizedChatId });
      return c.json({ ok: true });
    }

    if (!text.trim()) {
      return c.json({ ok: true });
    }

    // Use chatId as the phone identifier for Telegram users
    // Prefix with "tg:" so it doesn't collide with phone numbers
    const userIdentifier = `tg:${chatId}`;

    // Enqueue for serial processing
    messageQueue.enqueue(userIdentifier, text, 'telegram').catch((err) => {
      logger.error('Telegram message queue error', { error: err, chatId });
    });

    return c.json({ ok: true });
  } catch (err) {
    logger.error('Telegram webhook error', { error: err });
    return c.json({ ok: true }, 200);
  }
});

export default telegramRouter;

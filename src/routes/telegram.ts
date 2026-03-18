import { Hono } from 'hono';
import { getAuthorizedChatId, transcribeVoiceMessage } from '../services/telegram.js';
import { messageQueue } from '../agent/message-queue.js';
import { rateLimiter } from '../security/rate-limiter.js';
import logger from '../utils/logger.js';

const telegramRouter = new Hono();

// Rate limit Telegram webhook
telegramRouter.use('*', rateLimiter({ maxRequests: 30, windowMs: 60_000, keyPrefix: 'rl:tg' }));

telegramRouter.post('/', async (c) => {
  try {
    const update = await c.req.json();
    const message = update.message;
    if (!message) return c.json({ ok: true });

    const chatId = String(message.chat.id);
    const from = message.from;

    // Auth check — ONLY authorized chat ID can use Atlas
    const authorizedChatId = getAuthorizedChatId();
    if (chatId !== authorizedChatId) {
      logger.warn('Blocked unauthorized Telegram message', { chatId, authorized: authorizedChatId });
      return c.json({ ok: true });
    }

    // Extract text from message — supports text, voice, audio, video notes, captions
    let text: string | null = null;

    if (message.text) {
      text = message.text;
    } else if (message.voice || message.audio || message.video_note) {
      // Voice message, audio file, or video note — transcribe
      const fileId = message.voice?.file_id || message.audio?.file_id || message.video_note?.file_id;
      if (fileId) {
        try {
          text = await transcribeVoiceMessage(fileId);
          logger.info('Voice message transcribed', { chatId, from: from?.first_name, length: text.length });
        } catch (err) {
          logger.error('Voice transcription failed', { error: err, chatId });
          text = null;
        }
      }
    } else if (message.caption) {
      // Photo/video/document with caption
      text = message.caption;
    }

    if (!text?.trim()) {
      return c.json({ ok: true });
    }

    logger.info('Incoming Telegram message', {
      chatId,
      from: from?.username || from?.first_name || 'unknown',
      length: text.length,
      type: message.voice ? 'voice' : message.audio ? 'audio' : message.video_note ? 'video_note' : message.caption ? 'caption' : 'text',
    });

    const userIdentifier = `tg:${chatId}`;

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

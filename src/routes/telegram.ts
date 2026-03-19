import { Hono } from 'hono';
import { getAuthorizedChatId, transcribeVoiceMessage, sendTelegramMessage, getTelegramBot } from '../services/telegram.js';
import { messageQueue } from '../agent/message-queue.js';
import { rateLimiter } from '../security/rate-limiter.js';
import { getEnv } from '../config/env.js';
import { recordError } from './health.js';
import logger from '../utils/logger.js';
import type { ImageAttachment } from '../types/index.js';

const telegramRouter = new Hono();

// Rate limit Telegram webhook
telegramRouter.use('*', rateLimiter({ maxRequests: 30, windowMs: 60_000, keyPrefix: 'rl:tg' }));

// Telegram webhook secret_token verification
telegramRouter.use('*', async (c, next) => {
  const secret = getEnv().TELEGRAM_WEBHOOK_SECRET;
  if (secret) {
    const headerToken = c.req.header('x-telegram-bot-api-secret-token');
    if (headerToken !== secret) {
      logger.warn('Telegram webhook secret mismatch', { received: !!headerToken });
      return c.json({ ok: true }, 401);
    }
  }
  return next();
});

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

    // Extract text and images from message
    let text: string | null = null;
    let images: ImageAttachment[] | undefined;

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
    } else if (message.photo) {
      // Photo message — download image and send to Claude with vision
      const caption = message.caption || 'What is this image?';
      // Telegram sends multiple sizes; pick the largest (last in array)
      const photoSizes = message.photo as Array<{ file_id: string; width: number; height: number; file_size?: number }>;
      const largest = photoSizes[photoSizes.length - 1];
      if (largest) {
        try {
          const imageData = await downloadTelegramFile(largest.file_id);
          if (imageData) {
            images = [imageData];
            text = caption;
            logger.info('Photo received', { chatId, width: largest.width, height: largest.height, captionLength: caption.length });
          }
        } catch (err) {
          logger.error('Photo download failed', { error: err, chatId });
          text = caption; // Still process the caption even if image download fails
        }
      }
    } else if (message.video || message.animation) {
      // Video file sent directly — tell agent to use summarize_video tool with the file_id
      const fileId = message.video?.file_id || message.animation?.file_id;
      const caption = message.caption || '';
      if (fileId) {
        text = caption
          ? `${caption}\n\n(This message includes a video file. Use summarize_video with telegram_file_id="${fileId}" to process it.)`
          : `Summarize this video. Use summarize_video with telegram_file_id="${fileId}" to process it.`;
        logger.info('Video file received', { chatId, fileId, hasCaption: !!caption });
      }
    } else if (message.document) {
      // Document with photo (sometimes images are sent as documents)
      const doc = message.document;
      const caption = message.caption || 'What is this?';
      if (doc.mime_type?.startsWith('image/')) {
        try {
          const imageData = await downloadTelegramFile(doc.file_id);
          if (imageData) {
            images = [imageData];
            text = caption;
            logger.info('Document image received', { chatId, mimeType: doc.mime_type });
          }
        } catch (err) {
          logger.error('Document image download failed', { error: err, chatId });
          text = caption;
        }
      } else {
        text = caption;
      }
    } else if (message.caption) {
      // Other message with caption
      text = message.caption;
    }

    if (!text?.trim()) {
      return c.json({ ok: true });
    }

    logger.info('Incoming Telegram message', {
      chatId,
      from: from?.username || from?.first_name || 'unknown',
      length: text.length,
      type: message.voice ? 'voice' : message.audio ? 'audio' : message.video_note ? 'video_note' : message.photo ? 'photo' : message.video ? 'video' : message.document ? 'document' : message.caption ? 'caption' : 'text',
      hasImages: !!(images && images.length > 0),
    });

    const userIdentifier = `tg:${chatId}`;

    messageQueue.enqueue(userIdentifier, text, 'telegram', images).catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('Telegram message queue error', { error: errMsg, chatId });
      recordError(err);
      // Send error notification so messages don't silently disappear
      sendTelegramMessage(chatId, '⚠️ Error processing your message. Please try again.').catch(() => {});
    });

    return c.json({ ok: true });
  } catch (err) {
    logger.error('Telegram webhook error', { error: err });
    return c.json({ ok: true }, 200);
  }
});

/** Download a Telegram file by file_id and return as base64 ImageAttachment */
async function downloadTelegramFile(fileId: string): Promise<ImageAttachment | null> {
  const b = getTelegramBot();
  if (!b) return null;

  const file = await b.api.getFile(fileId);
  const filePath = file.file_path;
  if (!filePath) return null;

  const token = getEnv().TELEGRAM_BOT_TOKEN;
  const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const response = await fetch(fileUrl);
  if (!response.ok) {
    logger.error('Failed to download Telegram file', { fileId, status: response.status });
    return null;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const base64 = buffer.toString('base64');

  // Determine media type from file extension
  const ext = filePath.split('.').pop()?.toLowerCase() || 'jpg';
  const mediaTypeMap: Record<string, ImageAttachment['mediaType']> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
  };
  const mediaType = mediaTypeMap[ext] || 'image/jpeg';

  logger.info('Telegram file downloaded', { fileId, sizeBytes: buffer.length, mediaType });
  return { base64, mediaType };
}

export default telegramRouter;

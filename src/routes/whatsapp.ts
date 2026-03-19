import { Hono } from 'hono';
import { isAuthorizedUser } from '../security/auth.js';
import { twilioWebhookMiddleware } from '../security/webhook-validator.js';
import { rateLimiter } from '../security/rate-limiter.js';
import { messageQueue } from '../agent/message-queue.js';
import { getEnv } from '../config/env.js';
import logger from '../utils/logger.js';
import type { ImageAttachment } from '../types/index.js';

const whatsappRouter = new Hono();

// Apply middleware
whatsappRouter.use('*', rateLimiter({ maxRequests: 30, windowMs: 60_000, keyPrefix: 'rl:wa' }));
whatsappRouter.use('*', twilioWebhookMiddleware);

whatsappRouter.post('/', async (c) => {
  const body = await c.req.parseBody();

  const from = (body['From'] as string) || '';
  const messageBody = (body['Body'] as string) || '';
  const messageSid = (body['MessageSid'] as string) || '';
  const numMedia = parseInt((body['NumMedia'] as string) || '0', 10);

  logger.info('Incoming WhatsApp message', { from, sid: messageSid, length: messageBody.length, numMedia });

  // Auth check — ONLY JP can use Atlas
  if (!isAuthorizedUser(from)) {
    logger.warn('Blocked unauthorized message', { from });
    return c.text('', 200);
  }

  // Download any attached images
  let images: ImageAttachment[] | undefined;
  if (numMedia > 0) {
    images = [];
    for (let i = 0; i < numMedia; i++) {
      const mediaUrl = body[`MediaUrl${i}`] as string;
      const mediaContentType = (body[`MediaContentType${i}`] as string) || '';

      if (mediaUrl && mediaContentType.startsWith('image/')) {
        try {
          const imageData = await downloadWhatsAppMedia(mediaUrl, mediaContentType);
          if (imageData) images.push(imageData);
        } catch (err) {
          logger.error('WhatsApp media download failed', { error: err, mediaUrl });
        }
      }
    }
    if (images.length === 0) images = undefined;
  }

  const text = messageBody.trim() || (images ? 'What is this image?' : '');
  if (!text) {
    return c.text('', 200);
  }

  // Normalize phone number
  const phone = from.replace(/^whatsapp:/, '');

  // Enqueue for serial processing (don't await — respond to Twilio fast)
  messageQueue.enqueue(phone, text, 'whatsapp', images).catch((err) => {
    logger.error('Message queue error', { error: err, phone });
  });

  // Respond to Twilio immediately (empty TwiML = no auto-reply)
  return c.text('', 200);
});

/** Download a WhatsApp media file from Twilio and return as ImageAttachment */
async function downloadWhatsAppMedia(mediaUrl: string, contentType: string): Promise<ImageAttachment | null> {
  const env = getEnv();
  const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');

  const response = await fetch(mediaUrl, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!response.ok) {
    logger.error('Failed to download WhatsApp media', { status: response.status, mediaUrl });
    return null;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const base64 = buffer.toString('base64');

  // Map content type to allowed Claude media types
  const typeMap: Record<string, ImageAttachment['mediaType']> = {
    'image/jpeg': 'image/jpeg',
    'image/png': 'image/png',
    'image/gif': 'image/gif',
    'image/webp': 'image/webp',
  };
  const mediaType = typeMap[contentType] || 'image/jpeg';

  logger.info('WhatsApp media downloaded', { sizeBytes: buffer.length, mediaType });
  return { base64, mediaType };
}

export default whatsappRouter;

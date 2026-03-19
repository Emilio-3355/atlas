import { Hono } from 'hono';
import { isAuthorizedUser } from '../security/auth.js';
import { twilioWebhookMiddleware } from '../security/webhook-validator.js';
import { rateLimiter } from '../security/rate-limiter.js';
import { messageQueue } from '../agent/message-queue.js';
import logger from '../utils/logger.js';

const whatsappRouter = new Hono();

// Apply middleware
whatsappRouter.use('*', rateLimiter({ maxRequests: 30, windowMs: 60_000, keyPrefix: 'rl:wa' }));
whatsappRouter.use('*', twilioWebhookMiddleware);

whatsappRouter.post('/', async (c) => {
  const body = await c.req.parseBody();

  const from = (body['From'] as string) || '';
  const messageBody = (body['Body'] as string) || '';
  const messageSid = (body['MessageSid'] as string) || '';

  logger.info('Incoming WhatsApp message', { from, sid: messageSid, length: messageBody.length });

  // Auth check — ONLY JP can use Atlas
  if (!isAuthorizedUser(from)) {
    logger.warn('Blocked unauthorized message', { from });
    // Return 200 to Twilio (so it doesn't retry) but don't respond
    return c.text('', 200);
  }

  if (!messageBody.trim()) {
    return c.text('', 200);
  }

  // Normalize phone number
  const phone = from.replace(/^whatsapp:/, '');

  // Enqueue for serial processing (don't await — respond to Twilio fast)
  messageQueue.enqueue(phone, messageBody).catch((err) => {
    logger.error('Message queue error', { error: err, phone });
  });

  // Respond to Twilio immediately (empty TwiML = no auto-reply)
  return c.text('', 200);
});

export default whatsappRouter;

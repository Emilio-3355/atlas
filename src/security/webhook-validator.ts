import crypto from 'crypto';
import type { Context, Next } from 'hono';
import { getEnv } from '../config/env.js';
import logger from '../utils/logger.js';

// Twilio X-Twilio-Signature HMAC-SHA1 validation
export function validateTwilioSignature(url: string, params: Record<string, string>, signature: string): boolean {
  const authToken = getEnv().TWILIO_AUTH_TOKEN;

  // Build the data string: URL + sorted params concatenated
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }

  const expected = crypto
    .createHmac('sha1', authToken)
    .update(data, 'utf-8')
    .digest('base64');

  return crypto.timingSafeEqual(
    Buffer.from(signature, 'base64'),
    Buffer.from(expected, 'base64')
  );
}

export async function twilioWebhookMiddleware(c: Context, next: Next) {
  // Skip validation in development
  if (getEnv().NODE_ENV === 'development') {
    return next();
  }

  const signature = c.req.header('x-twilio-signature');
  if (!signature) {
    logger.warn('Missing Twilio signature');
    return c.text('Unauthorized', 401);
  }

  const body = await c.req.parseBody();
  const url = getEnv().BASE_URL + '/webhook/whatsapp';

  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string') {
      params[key] = value;
    }
  }

  if (!validateTwilioSignature(url, params, signature)) {
    logger.warn('Invalid Twilio signature');
    return c.text('Unauthorized', 401);
  }

  return next();
}

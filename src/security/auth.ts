import { getEnv } from '../config/env.js';
import logger from '../utils/logger.js';

// Extract last 10 digits for comparison.
// Mexican numbers may arrive as +52XXXXXXXXXX or +521XXXXXXXXXX from Twilio.
function extractDigits(phone: string): string {
  return phone.replace(/\D/g, '').slice(-10);
}

export function isAuthorizedUser(phone: string): boolean {
  // Telegram users are authorized via chat ID in the route layer
  if (phone.startsWith('tg:')) return true;

  const jpDigits = extractDigits(getEnv().JP_PHONE_NUMBER);
  const incomingDigits = extractDigits(phone);

  if (incomingDigits === jpDigits) return true;

  logger.warn('Unauthorized access attempt', { phone });
  return false;
}

import { getEnv } from '../config/env.js';
import logger from '../utils/logger.js';

// Normalize phone numbers for comparison (strip whatsapp: prefix)
function normalizePhone(phone: string): string {
  return phone.replace(/^whatsapp:/, '').replace(/\s+/g, '');
}

export function isAuthorizedUser(phone: string): boolean {
  const jpPhone = normalizePhone(getEnv().JP_PHONE_NUMBER);
  const incoming = normalizePhone(phone);

  if (incoming === jpPhone) return true;

  logger.warn('Unauthorized access attempt', { phone: incoming });
  return false;
}

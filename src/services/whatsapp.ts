import twilio from 'twilio';
import { getEnv } from '../config/env.js';
import logger from '../utils/logger.js';

let twilioClient: twilio.Twilio | null = null;

function getClient(): twilio.Twilio {
  if (!twilioClient) {
    const env = getEnv();
    twilioClient = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  }
  return twilioClient;
}

// Channel-agnostic: if TWILIO_WHATSAPP_NUMBER starts with "whatsapp:" → WhatsApp mode.
// Otherwise → regular SMS/MMS mode.
function isWhatsAppMode(): boolean {
  return getEnv().TWILIO_WHATSAPP_NUMBER.startsWith('whatsapp:');
}

function formatNumber(phone: string): string {
  if (isWhatsAppMode()) {
    return phone.startsWith('whatsapp:') ? phone : `whatsapp:${phone}`;
  }
  // SMS mode: strip whatsapp: prefix if present
  return phone.replace(/^whatsapp:/, '');
}

function getFromNumber(): string {
  const num = getEnv().TWILIO_WHATSAPP_NUMBER;
  if (isWhatsAppMode()) return num;
  // SMS mode: return as-is (plain phone number)
  return num;
}

export async function sendWhatsAppMessage(to: string, body: string): Promise<string> {
  const from = getFromNumber();
  const toFormatted = formatNumber(to);

  try {
    const message = await getClient().messages.create({
      body,
      from,
      to: toFormatted,
    });
    logger.debug('Message sent', { sid: message.sid, to: toFormatted, channel: isWhatsAppMode() ? 'whatsapp' : 'sms' });
    return message.sid;
  } catch (err) {
    logger.error('Failed to send message', { error: err, to: toFormatted });
    throw err;
  }
}

export async function sendWhatsAppImage(to: string, mediaUrl: string, caption?: string): Promise<string> {
  const from = getFromNumber();
  const toFormatted = formatNumber(to);

  try {
    const message = await getClient().messages.create({
      from,
      to: toFormatted,
      mediaUrl: [mediaUrl],
      body: caption || '',
    });
    logger.debug('Image sent', { sid: message.sid, to: toFormatted, channel: isWhatsAppMode() ? 'whatsapp' : 'sms' });
    return message.sid;
  } catch (err) {
    logger.error('Failed to send image', { error: err, to: toFormatted });
    throw err;
  }
}

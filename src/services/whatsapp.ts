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

export async function sendWhatsAppMessage(to: string, body: string): Promise<string> {
  const env = getEnv();
  const from = env.TWILIO_WHATSAPP_NUMBER.startsWith('whatsapp:')
    ? env.TWILIO_WHATSAPP_NUMBER
    : `whatsapp:${env.TWILIO_WHATSAPP_NUMBER}`;
  const toFormatted = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;

  try {
    const message = await getClient().messages.create({
      body,
      from,
      to: toFormatted,
    });
    logger.debug('WhatsApp message sent', { sid: message.sid, to: toFormatted });
    return message.sid;
  } catch (err) {
    logger.error('Failed to send WhatsApp message', { error: err, to: toFormatted });
    throw err;
  }
}

export async function sendWhatsAppImage(to: string, mediaUrl: string, caption?: string): Promise<string> {
  const env = getEnv();
  const from = env.TWILIO_WHATSAPP_NUMBER.startsWith('whatsapp:')
    ? env.TWILIO_WHATSAPP_NUMBER
    : `whatsapp:${env.TWILIO_WHATSAPP_NUMBER}`;
  const toFormatted = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;

  try {
    const message = await getClient().messages.create({
      from,
      to: toFormatted,
      mediaUrl: [mediaUrl],
      body: caption || '',
    });
    logger.debug('WhatsApp image sent', { sid: message.sid, to: toFormatted });
    return message.sid;
  } catch (err) {
    logger.error('Failed to send WhatsApp image', { error: err, to: toFormatted });
    throw err;
  }
}

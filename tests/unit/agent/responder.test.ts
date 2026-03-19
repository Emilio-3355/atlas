import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/config/env.js', () => ({
  getEnv: () => ({ TELEGRAM_BOT_TOKEN: 'test', TWILIO_ACCOUNT_SID: 'test', TWILIO_AUTH_TOKEN: 'test', TWILIO_WHATSAPP_NUMBER: '+15551234567' }),
}));
vi.mock('../../../src/utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockSendWhatsApp = vi.fn().mockResolvedValue(undefined);
const mockSendWhatsAppImage = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../src/services/whatsapp.js', () => ({
  sendWhatsAppMessage: (...args: any[]) => mockSendWhatsApp(...args),
  sendWhatsAppImage: (...args: any[]) => mockSendWhatsAppImage(...args),
}));

const mockSendTelegram = vi.fn().mockResolvedValue(1);
const mockSendTelegramImage = vi.fn().mockResolvedValue(1);
vi.mock('../../../src/services/telegram.js', () => ({
  sendTelegramMessage: (...args: any[]) => mockSendTelegram(...args),
  sendTelegramImage: (...args: any[]) => mockSendTelegramImage(...args),
}));

const mockSendSlack = vi.fn().mockResolvedValue('ts');
const mockSendSlackImage = vi.fn().mockResolvedValue('ts');
vi.mock('../../../src/services/slack.js', () => ({
  sendSlackMessage: (...args: any[]) => mockSendSlack(...args),
  sendSlackImage: (...args: any[]) => mockSendSlackImage(...args),
}));

const { respondToUser, sendImage, detectMessageLanguage } = await import('../../../src/agent/responder.js');

describe('respondToUser', () => {
  it('sends via WhatsApp by default', async () => {
    await respondToUser('+1234', 'hello');
    expect(mockSendWhatsApp).toHaveBeenCalledWith('+1234', 'hello');
  });

  it('sends via Telegram when channel is telegram', async () => {
    await respondToUser('tg:123', 'hello', undefined, 'telegram');
    expect(mockSendTelegram).toHaveBeenCalledWith('123', 'hello');
  });

  it('sends via Slack when channel is slack', async () => {
    await respondToUser('slack:C123', 'hello', undefined, 'slack');
    expect(mockSendSlack).toHaveBeenCalledWith('C123', 'hello');
  });

  it('strips tg: prefix for Telegram chatId', async () => {
    await respondToUser('tg:99999', 'test', undefined, 'telegram');
    expect(mockSendTelegram).toHaveBeenCalledWith('99999', 'test');
  });

  it('strips slack: prefix for Slack channel', async () => {
    await respondToUser('slack:CHANNEL', 'test', undefined, 'slack');
    expect(mockSendSlack).toHaveBeenCalledWith('CHANNEL', 'test');
  });
});

describe('sendImage', () => {
  it('routes to WhatsApp by default', async () => {
    await sendImage('+1234', 'https://img.jpg', 'caption');
    expect(mockSendWhatsAppImage).toHaveBeenCalled();
  });

  it('routes to Telegram when channel is telegram', async () => {
    await sendImage('tg:123', 'https://img.jpg', 'caption', 'telegram');
    expect(mockSendTelegramImage).toHaveBeenCalledWith('123', 'https://img.jpg', 'caption');
  });

  it('routes to Slack when channel is slack', async () => {
    await sendImage('slack:C123', 'https://img.jpg', 'caption', 'slack');
    expect(mockSendSlackImage).toHaveBeenCalledWith('C123', 'https://img.jpg', 'caption');
  });
});

describe('detectMessageLanguage', () => {
  it('delegates to detectLanguage utility', () => {
    expect(detectMessageLanguage('hola')).toBe('es');
    expect(detectMessageLanguage('hello')).toBe('en');
  });
});

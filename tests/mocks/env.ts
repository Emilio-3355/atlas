import { vi } from 'vitest';

export const mockEnv = {
  NODE_ENV: 'test' as const,
  PORT: 3000,
  DATABASE_URL: 'postgresql://test:test@localhost:5432/atlas_test',
  REDIS_URL: 'redis://localhost:6379',
  ANTHROPIC_API_KEY: 'test-anthropic-key',
  OPENAI_API_KEY: 'test-openai-key',
  TWILIO_ACCOUNT_SID: 'test-twilio-sid',
  TWILIO_AUTH_TOKEN: 'test-twilio-token',
  TWILIO_PHONE_NUMBER: '+15551234567',
  JP_PHONE_NUMBER: '+15559876543',
  BASE_URL: 'https://test.example.com',
  TELEGRAM_BOT_TOKEN: 'test-telegram-token',
  TELEGRAM_CHAT_ID: '123456789',
  BRAVE_API_KEY: 'test-brave-key',
  SLACK_BOT_TOKEN: '',
  SLACK_SIGNING_SECRET: '',
  FINNHUB_API_KEY: 'test-finnhub-key',
  GMAIL_CLIENT_ID: '',
  GMAIL_CLIENT_SECRET: '',
  GMAIL_REDIRECT_URI: '',
  DASHBOARD_TOKEN: 'test-dashboard-token',
  DAEMON_SECRET: '',
};

export function setupEnvMock() {
  vi.mock('../../src/config/env.js', () => ({
    getEnv: () => ({ ...mockEnv }),
  }));
}

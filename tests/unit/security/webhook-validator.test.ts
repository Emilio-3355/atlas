import { describe, it, expect, vi } from 'vitest';
import crypto from 'crypto';

vi.mock('../../../src/utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../src/config/env.js', () => ({
  getEnv: () => ({
    NODE_ENV: 'production',
    TWILIO_AUTH_TOKEN: 'test-auth-token-12345',
    BASE_URL: 'https://test.example.com',
  }),
}));

const { validateTwilioSignature } = await import('../../../src/security/webhook-validator.js');

function computeValidSignature(url: string, params: Record<string, string>, authToken: string): string {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }
  return crypto.createHmac('sha1', authToken).update(data, 'utf-8').digest('base64');
}

describe('validateTwilioSignature', () => {
  const authToken = 'test-auth-token-12345';
  const url = 'https://test.example.com/webhook/whatsapp';
  const params = { Body: 'Hello', From: 'whatsapp:+1234' };

  it('returns true for valid signature', () => {
    const sig = computeValidSignature(url, params, authToken);
    expect(validateTwilioSignature(url, params, sig)).toBe(true);
  });

  it('returns false for invalid signature of same length', () => {
    const validSig = computeValidSignature(url, params, authToken);
    // Flip a char to make it invalid but keep same base64 length
    const chars = validSig.split('');
    chars[0] = chars[0] === 'A' ? 'B' : 'A';
    const invalidSig = chars.join('');
    expect(validateTwilioSignature(url, params, invalidSig)).toBe(false);
  });

  it('returns false (not throw) for invalid signature of different length', () => {
    // After our fix, this should return false instead of throwing
    expect(validateTwilioSignature(url, params, 'short')).toBe(false);
  });

  it('sorts params alphabetically', () => {
    const params2 = { Zebra: '1', Alpha: '2' };
    const sig = computeValidSignature(url, params2, authToken);
    expect(validateTwilioSignature(url, params2, sig)).toBe(true);
  });
});

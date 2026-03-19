import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../src/config/env.js', () => ({
  getEnv: () => ({
    JP_PHONE_NUMBER: '+15559876543',
  }),
}));

const { isAuthorizedUser } = await import('../../../src/security/auth.js');

describe('isAuthorizedUser', () => {
  it('returns true for JP phone number', () => {
    expect(isAuthorizedUser('+15559876543')).toBe(true);
  });

  it('returns true with whatsapp: prefix', () => {
    expect(isAuthorizedUser('whatsapp:+15559876543')).toBe(true);
  });

  it('returns true for +52 Mexican format (last 10 digits match)', () => {
    // JP phone is +15559876543, last 10 digits: 5559876543
    expect(isAuthorizedUser('+525559876543')).toBe(true);
  });

  it('returns true for +521 format', () => {
    expect(isAuthorizedUser('+5215559876543')).toBe(true);
  });

  it('returns false for different phone number', () => {
    expect(isAuthorizedUser('+11111111111')).toBe(false);
  });

  it('returns true for any tg: prefixed ID', () => {
    expect(isAuthorizedUser('tg:12345')).toBe(true);
  });

  it('returns true for tg: with any chat ID', () => {
    expect(isAuthorizedUser('tg:999999999')).toBe(true);
  });
});

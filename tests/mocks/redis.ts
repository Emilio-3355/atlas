import { vi } from 'vitest';

const store = new Map<string, string>();

export const mockRedis = {
  get: vi.fn((key: string) => store.get(key) ?? null),
  set: vi.fn((key: string, value: string) => { store.set(key, value); return 'OK'; }),
  setex: vi.fn((key: string, _ttl: number, value: string) => { store.set(key, value); return 'OK'; }),
  incr: vi.fn((key: string) => {
    const val = parseInt(store.get(key) || '0', 10) + 1;
    store.set(key, String(val));
    return val;
  }),
  expire: vi.fn(() => 1),
  ping: vi.fn(() => 'PONG'),
  del: vi.fn((key: string) => { store.delete(key); return 1; }),
  quit: vi.fn(),
};

export function setupRedisMock() {
  vi.mock('../../src/config/redis.js', () => ({
    getRedis: () => mockRedis,
    connectRedis: vi.fn(),
    closeRedis: vi.fn(),
    setJSON: vi.fn(),
    getJSON: vi.fn(),
  }));
}

export function clearRedisStore() {
  store.clear();
  vi.clearAllMocks();
}

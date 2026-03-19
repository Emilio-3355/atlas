import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('../../../src/utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Track Redis mock behavior
let redisShouldFail = false;
const mockRedis = {
  incr: vi.fn().mockImplementation(async () => {
    if (redisShouldFail) throw new Error('Redis connection refused');
    return 1;
  }),
  expire: vi.fn().mockResolvedValue(1),
};

vi.mock('../../../src/config/redis.js', () => ({
  getRedis: () => {
    if (redisShouldFail) throw new Error('Redis connection refused');
    return mockRedis;
  },
}));

const { rateLimiter } = await import('../../../src/security/rate-limiter.js');

// Helper to create a mock Hono context
function createMockContext(ip = '192.168.1.1') {
  const headers: Record<string, string> = {};
  let responseStatus: number | undefined;
  let responseBody: string | undefined;
  let nextCalled = false;

  const c = {
    req: {
      header: (name: string) => (name === 'x-forwarded-for' ? ip : undefined),
    },
    header: (name: string, value: string) => {
      headers[name] = value;
    },
    text: (body: string, status: number) => {
      responseStatus = status;
      responseBody = body;
      return { status, body };
    },
  };

  const next = vi.fn().mockImplementation(async () => {
    nextCalled = true;
  });

  return { c, next, getHeaders: () => headers, getStatus: () => responseStatus, getBody: () => responseBody, wasNextCalled: () => nextCalled };
}

describe('rateLimiter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisShouldFail = false;
    mockRedis.incr.mockImplementation(async () => 1);
  });

  // --- Return type ---

  describe('factory function', () => {
    it('returns a middleware function', () => {
      const middleware = rateLimiter();
      expect(typeof middleware).toBe('function');
    });

    it('returns a function that accepts context and next', () => {
      const middleware = rateLimiter();
      expect(middleware.length).toBe(2); // (c, next)
    });

    it('accepts custom config', () => {
      const middleware = rateLimiter({ windowMs: 120_000, maxRequests: 100, keyPrefix: 'custom' });
      expect(typeof middleware).toBe('function');
    });

    it('works with empty config (uses defaults)', () => {
      const middleware = rateLimiter({});
      expect(typeof middleware).toBe('function');
    });
  });

  // --- Redis path ---

  describe('with Redis available', () => {
    it('calls next() when under limit', async () => {
      mockRedis.incr.mockResolvedValue(1);
      const middleware = rateLimiter();
      const { c, next } = createMockContext();
      await middleware(c as any, next);
      expect(next).toHaveBeenCalled();
    });

    it('calls redis.incr with correct key', async () => {
      mockRedis.incr.mockResolvedValue(1);
      const middleware = rateLimiter({ keyPrefix: 'test' });
      const { c, next } = createMockContext('10.0.0.1');
      await middleware(c as any, next);
      expect(mockRedis.incr).toHaveBeenCalledWith('test:10.0.0.1');
    });

    it('sets expire on first request (incr returns 1)', async () => {
      mockRedis.incr.mockResolvedValue(1);
      const middleware = rateLimiter({ windowMs: 60_000 });
      const { c, next } = createMockContext();
      await middleware(c as any, next);
      expect(mockRedis.expire).toHaveBeenCalledWith('rl:192.168.1.1', 60);
    });

    it('does not set expire on subsequent requests (incr > 1)', async () => {
      mockRedis.incr.mockResolvedValue(5);
      const middleware = rateLimiter();
      const { c, next } = createMockContext();
      await middleware(c as any, next);
      expect(mockRedis.expire).not.toHaveBeenCalled();
    });

    it('sets rate limit headers', async () => {
      mockRedis.incr.mockResolvedValue(5);
      const middleware = rateLimiter({ maxRequests: 30 });
      const { c, next, getHeaders } = createMockContext();
      await middleware(c as any, next);
      expect(getHeaders()['X-RateLimit-Limit']).toBe('30');
      expect(getHeaders()['X-RateLimit-Remaining']).toBe('25');
    });

    it('remaining never goes below 0', async () => {
      mockRedis.incr.mockResolvedValue(50);
      const middleware = rateLimiter({ maxRequests: 30 });
      const { c, next, getHeaders } = createMockContext();
      await middleware(c as any, next);
      expect(getHeaders()['X-RateLimit-Remaining']).toBe('0');
    });

    it('returns 429 when over limit', async () => {
      mockRedis.incr.mockResolvedValue(31);
      const middleware = rateLimiter({ maxRequests: 30 });
      const { c, next, getStatus, getBody } = createMockContext();
      const response = await middleware(c as any, next);
      expect(next).not.toHaveBeenCalled();
      expect(getStatus()).toBe(429);
      expect(getBody()).toBe('Too Many Requests');
    });

    it('allows request at exactly maxRequests', async () => {
      mockRedis.incr.mockResolvedValue(30);
      const middleware = rateLimiter({ maxRequests: 30 });
      const { c, next } = createMockContext();
      await middleware(c as any, next);
      expect(next).toHaveBeenCalled();
    });

    it('blocks request at maxRequests + 1', async () => {
      mockRedis.incr.mockResolvedValue(31);
      const middleware = rateLimiter({ maxRequests: 30 });
      const { c, next } = createMockContext();
      await middleware(c as any, next);
      expect(next).not.toHaveBeenCalled();
    });
  });

  // --- In-memory fallback ---

  describe('in-memory fallback when Redis unavailable', () => {
    beforeEach(() => {
      redisShouldFail = true;
    });

    it('falls back to in-memory when Redis throws', async () => {
      const middleware = rateLimiter({ maxRequests: 100 });
      const { c, next } = createMockContext();
      await middleware(c as any, next);
      // Should still call next (count is 1, well under 100)
      expect(next).toHaveBeenCalled();
    });

    it('sets rate limit headers with fallback', async () => {
      const middleware = rateLimiter({ maxRequests: 50 });
      const { c, next, getHeaders } = createMockContext('fallback-ip');
      await middleware(c as any, next);
      expect(getHeaders()['X-RateLimit-Limit']).toBe('50');
      // First request, count=1, remaining=49
      expect(getHeaders()['X-RateLimit-Remaining']).toBe('49');
    });

    it('increments count across multiple calls with same key', async () => {
      const middleware = rateLimiter({ maxRequests: 3, keyPrefix: 'mem' });

      // Call 3 times from same IP — all should succeed
      for (let i = 0; i < 3; i++) {
        const { c, next } = createMockContext('repeat-ip');
        await middleware(c as any, next);
        expect(next).toHaveBeenCalled();
      }

      // 4th call should be blocked
      const { c, next, getStatus } = createMockContext('repeat-ip');
      await middleware(c as any, next);
      expect(next).not.toHaveBeenCalled();
      expect(getStatus()).toBe(429);
    });

    it('uses "unknown" when x-forwarded-for is absent', async () => {
      const middleware = rateLimiter({ maxRequests: 10 });
      const { c, next, getHeaders } = createMockContext(undefined as any);
      await middleware(c as any, next);
      expect(next).toHaveBeenCalled();
      expect(getHeaders()['X-RateLimit-Limit']).toBe('10');
    });

    it('different IPs have separate counters', async () => {
      const middleware = rateLimiter({ maxRequests: 1, keyPrefix: 'iso' });

      // First IP, first request -> allowed
      const { c: c1, next: n1 } = createMockContext('ip-a');
      await middleware(c1 as any, n1);
      expect(n1).toHaveBeenCalled();

      // Second IP, first request -> also allowed
      const { c: c2, next: n2 } = createMockContext('ip-b');
      await middleware(c2 as any, n2);
      expect(n2).toHaveBeenCalled();

      // First IP, second request -> blocked
      const { c: c3, next: n3 } = createMockContext('ip-a');
      await middleware(c3 as any, n3);
      expect(n3).not.toHaveBeenCalled();
    });
  });

  // --- Custom configuration ---

  describe('custom configuration', () => {
    it('respects custom maxRequests', async () => {
      mockRedis.incr.mockResolvedValue(6);
      const middleware = rateLimiter({ maxRequests: 5 });
      const { c, next } = createMockContext();
      await middleware(c as any, next);
      expect(next).not.toHaveBeenCalled();
    });

    it('respects custom keyPrefix', async () => {
      mockRedis.incr.mockResolvedValue(1);
      const middleware = rateLimiter({ keyPrefix: 'api' });
      const { c, next } = createMockContext('1.2.3.4');
      await middleware(c as any, next);
      expect(mockRedis.incr).toHaveBeenCalledWith('api:1.2.3.4');
    });
  });
});

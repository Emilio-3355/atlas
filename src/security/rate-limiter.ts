import type { Context, Next } from 'hono';
import { getRedis } from '../config/redis.js';
import logger from '../utils/logger.js';

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyPrefix: string;
}

const DEFAULTS: RateLimitConfig = {
  windowMs: 60_000,   // 1 minute
  maxRequests: 30,     // 30 requests per minute
  keyPrefix: 'rl',
};

// In-memory fallback when Redis is unavailable
const memoryCounters = new Map<string, { count: number; expiresAt: number }>();

function memoryIncr(key: string, windowMs: number): number {
  const now = Date.now();
  const entry = memoryCounters.get(key);
  if (!entry || entry.expiresAt <= now) {
    memoryCounters.set(key, { count: 1, expiresAt: now + windowMs });
    return 1;
  }
  entry.count++;
  return entry.count;
}

// Periodic cleanup to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memoryCounters) {
    if (entry.expiresAt <= now) memoryCounters.delete(key);
  }
}, 60_000);

export function rateLimiter(config: Partial<RateLimitConfig> = {}) {
  const { windowMs, maxRequests, keyPrefix } = { ...DEFAULTS, ...config };
  const windowSeconds = Math.ceil(windowMs / 1000);

  return async (c: Context, next: Next) => {
    const ip = c.req.header('x-forwarded-for') || 'unknown';
    const key = `${keyPrefix}:${ip}`;

    let current: number;

    try {
      const redis = getRedis();
      current = await redis.incr(key);

      if (current === 1) {
        await redis.expire(key, windowSeconds);
      }
    } catch (err) {
      // Redis unavailable — fall back to in-memory rate limiting
      logger.warn('Rate limiter Redis unavailable, using in-memory fallback', { error: err instanceof Error ? err.message : String(err) });
      current = memoryIncr(key, windowMs);
    }

    c.header('X-RateLimit-Limit', String(maxRequests));
    c.header('X-RateLimit-Remaining', String(Math.max(0, maxRequests - current)));

    if (current > maxRequests) {
      logger.warn('Rate limit exceeded', { ip, current, max: maxRequests });
      return c.text('Too Many Requests', 429);
    }

    return next();
  };
}

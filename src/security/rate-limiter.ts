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

export function rateLimiter(config: Partial<RateLimitConfig> = {}) {
  const { windowMs, maxRequests, keyPrefix } = { ...DEFAULTS, ...config };
  const windowSeconds = Math.ceil(windowMs / 1000);

  return async (c: Context, next: Next) => {
    const ip = c.req.header('x-forwarded-for') || 'unknown';
    const key = `${keyPrefix}:${ip}`;

    try {
      const redis = getRedis();
      const current = await redis.incr(key);

      if (current === 1) {
        await redis.expire(key, windowSeconds);
      }

      c.header('X-RateLimit-Limit', String(maxRequests));
      c.header('X-RateLimit-Remaining', String(Math.max(0, maxRequests - current)));

      if (current > maxRequests) {
        logger.warn('Rate limit exceeded', { ip, current, max: maxRequests });
        return c.text('Too Many Requests', 429);
      }
    } catch (err) {
      // If Redis is down, allow the request (fail open for rate limiting)
      logger.error('Rate limiter Redis error', { error: err });
    }

    return next();
  };
}

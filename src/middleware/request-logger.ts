import type { Context, Next } from 'hono';
import logger from '../utils/logger.js';

export async function requestLogger(c: Context, next: Next) {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;

  logger.info('Request', {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs: duration,
  });
}

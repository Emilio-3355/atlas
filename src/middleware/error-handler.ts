import type { Context } from 'hono';
import logger from '../utils/logger.js';

export function errorHandler(err: Error, c: Context) {
  logger.error('Unhandled error', { error: err.message, stack: err.stack, path: c.req.path });

  return c.json(
    { error: 'Internal server error' },
    500
  );
}

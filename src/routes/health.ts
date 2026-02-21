import { Hono } from 'hono';
import { query } from '../config/database.js';
import { getRedis } from '../config/redis.js';

const healthRouter = new Hono();

healthRouter.get('/', async (c) => {
  const checks: Record<string, string> = {};

  // PostgreSQL check
  try {
    await query('SELECT 1');
    checks.database = 'ok';
  } catch (err) {
    checks.database = 'error';
  }

  // Redis check
  try {
    const redis = getRedis();
    await redis.ping();
    checks.redis = 'ok';
  } catch (err) {
    checks.redis = 'error';
  }

  const allOk = Object.values(checks).every((v) => v === 'ok');

  return c.json(
    {
      status: allOk ? 'healthy' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    },
    allOk ? 200 : 503
  );
});

export default healthRouter;

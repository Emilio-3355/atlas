import { Hono } from 'hono';
import { query } from '../config/database.js';
import { getRedis } from '../config/redis.js';
import { getToolRegistry } from '../tools/registry.js';

// In-memory error ring buffer for debugging (last 10 errors)
const recentErrors: Array<{ timestamp: string; error: string; stack?: string }> = [];
export function recordError(err: unknown): void {
  const entry = {
    timestamp: new Date().toISOString(),
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack?.split('\n').slice(0, 5).join('\n') : undefined,
  };
  recentErrors.push(entry);
  if (recentErrors.length > 10) recentErrors.shift();
}

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

// Debug endpoint — shows recent errors and tool count
healthRouter.get('/debug', async (c) => {
  const registry = getToolRegistry();
  const toolNames = registry.getNames();

  let dbTables: string[] = [];
  try {
    const res = await query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
    dbTables = res.rows.map((r: any) => r.tablename);
  } catch (err) {
    dbTables = [`error: ${err instanceof Error ? err.message : String(err)}`];
  }

  return c.json({
    tools: { count: toolNames.length, names: toolNames },
    recentErrors,
    dbTables,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});

export default healthRouter;

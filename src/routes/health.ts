import { Hono } from 'hono';
import { query } from '../config/database.js';
import { getRedis } from '../config/redis.js';
import { getToolRegistry } from '../tools/registry.js';
import { getEnv } from '../config/env.js';

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

// Auth gate for debug endpoints — require DASHBOARD_TOKEN in production
function debugAuth(c: any): boolean {
  const token = getEnv().DASHBOARD_TOKEN;
  if (!token) return true; // No token = dev mode, allow
  const provided = c.req.query('token') || c.req.header('authorization')?.replace('Bearer ', '');
  return provided === token;
}

// Debug: dump conversation messages for the active Telegram conversation
healthRouter.get('/debug/messages', async (c) => {
  if (!debugAuth(c)) return c.json({ error: 'Unauthorized' }, 401);
  try {
    const conv = await query(
      `SELECT * FROM conversations WHERE user_phone LIKE 'tg:%' AND status = 'active'
       ORDER BY updated_at DESC LIMIT 1`
    );
    if (conv.rows.length === 0) return c.json({ error: 'No active telegram conversation' });

    const convId = conv.rows[0].id;
    const msgs = await query(
      `SELECT id, role, LEFT(content, 200) as content_preview, tool_name,
       LENGTH(content) as content_length, created_at
       FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 25`,
      [convId]
    );

    return c.json({
      conversation: { id: convId, phone: conv.rows[0].user_phone, messageCount: conv.rows[0].message_count },
      messages: msgs.rows,
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Debug endpoint — shows recent errors and tool count
healthRouter.get('/debug', async (c) => {
  if (!debugAuth(c)) return c.json({ error: 'Unauthorized' }, 401);
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

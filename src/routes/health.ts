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

// Debug: dump conversation messages for a specific or most recent conversation
healthRouter.get('/debug/messages', async (c) => {
  if (!debugAuth(c)) return c.json({ error: 'Unauthorized' }, 401);
  try {
    const phoneFilter = c.req.query('phone');
    const conv = phoneFilter
      ? await query(`SELECT * FROM conversations WHERE user_phone = $1 AND status = 'active' ORDER BY updated_at DESC LIMIT 1`, [phoneFilter])
      : await query(`SELECT * FROM conversations WHERE status = 'active' ORDER BY message_count DESC, updated_at DESC LIMIT 1`);
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

// Debug: recent tool usage
healthRouter.get('/debug/tools', async (c) => {
  if (!debugAuth(c)) return c.json({ error: 'Unauthorized' }, 401);
  try {
    const tools = await query(
      `SELECT tool_name, success, duration_ms, LEFT(error_message, 200) as error_preview, created_at
       FROM tool_usage ORDER BY created_at DESC LIMIT 20`
    );
    return c.json({ recentToolCalls: tools.rows });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Debug: all recent conversations
healthRouter.get('/debug/conversations', async (c) => {
  if (!debugAuth(c)) return c.json({ error: 'Unauthorized' }, 401);
  try {
    const convs = await query(
      `SELECT id, user_phone, status, message_count, language, updated_at
       FROM conversations ORDER BY updated_at DESC LIMIT 10`
    );
    return c.json({ conversations: convs.rows });
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

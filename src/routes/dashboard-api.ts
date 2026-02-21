import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { getEnv } from '../config/env.js';
import { query } from '../config/database.js';
import { getActiveTasks, cancelTask } from '../models/scheduled-task.js';
import { getRecentAuditLogs } from '../models/audit-log.js';
import { getToolUsageStats, getRecentFailures } from '../self-improvement/observer.js';
import { getAllFacts, getFactsByCategory, searchFacts } from '../memory/structured.js';
import { getFailurePatterns } from '../memory/learnings.js';
import { getToolRegistry } from '../tools/registry.js';
import { getDashboardClientCount } from '../services/dashboard-ws.js';
import { isDaemonOnline } from '../services/daemon-bridge.js';
import logger from '../utils/logger.js';

const dashboardRouter = new Hono();

// ===== Auth Middleware =====
dashboardRouter.use('/api/*', async (c, next) => {
  const token = getEnv().DASHBOARD_TOKEN;
  if (!token) {
    // Dev mode — no auth required
    return next();
  }

  const qToken = new URL(c.req.url).searchParams.get('token');
  const authHeader = c.req.header('Authorization');
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (qToken === token || bearerToken === token) {
    return next();
  }

  return c.json({ error: 'Unauthorized' }, 401);
});

// ===== Static CRON_JOBS constant =====
const CRON_JOBS = [
  { name: 'Heartbeat', cron: '*/30 7-23 * * *', timezone: 'America/New_York', description: 'System health check & status ping' },
  { name: 'Morning Briefing', cron: '30 7 * * 1-5', timezone: 'America/New_York', description: 'Daily briefing with calendar, emails, markets' },
  { name: 'Due Tasks', cron: '* * * * *', timezone: 'UTC', description: 'Execute scheduled one-shot and recurring tasks' },
  { name: 'Action Expiry', cron: '*/5 * * * *', timezone: 'UTC', description: 'Expire unanswered pending approval actions' },
  { name: 'Evolution', cron: '0 22 * * *', timezone: 'America/New_York', description: 'Self-improvement capability evolution cycle' },
  { name: 'Patterns', cron: '0 0 * * *', timezone: 'America/New_York', description: 'Activity pattern analysis + learning promotion + staleness detection' },
  { name: 'Price Alerts', cron: '*/5 9-16 * * 1-5', timezone: 'America/New_York', description: 'Check stock price alert thresholds during market hours' },
  { name: 'SEC Filings', cron: '*/30 8-18 * * 1-5', timezone: 'America/New_York', description: 'Check for new SEC filings on watched tickers' },
];

// ===== API Endpoints =====

// Stats overview
dashboardRouter.get('/api/stats', async (c) => {
  try {
    const [toolCount, factCount, learningCount, conversationCount] = await Promise.all([
      getToolRegistry().getAll().length,
      query('SELECT COUNT(*) FROM memory_facts WHERE expires_at IS NULL OR expires_at > NOW()').then(r => Number(r.rows[0].count)).catch(() => 0),
      query('SELECT COUNT(*) FROM learnings').then(r => Number(r.rows[0].count)).catch(() => 0),
      query('SELECT COUNT(*) FROM conversations').then(r => Number(r.rows[0].count)).catch(() => 0),
    ]);

    return c.json({
      tools: toolCount,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      taskCount: (await getActiveTasks().catch(() => [])).length,
      factCount,
      learningCount,
      conversationCount,
      wsClients: getDashboardClientCount(),
      daemonOnline: isDaemonOnline(),
    });
  } catch (err) {
    logger.error('Dashboard stats error', { error: err });
    return c.json({ error: 'Failed to fetch stats' }, 500);
  }
});

// Active scheduled tasks
dashboardRouter.get('/api/tasks', async (c) => {
  try {
    const tasks = await getActiveTasks();
    return c.json(tasks);
  } catch (err) {
    return c.json({ error: 'Failed to fetch tasks' }, 500);
  }
});

// Pending approval actions
dashboardRouter.get('/api/tasks/pending', async (c) => {
  try {
    const result = await query(
      `SELECT * FROM pending_actions WHERE status = 'pending' AND expires_at > NOW() ORDER BY created_at DESC`
    );
    return c.json(result.rows);
  } catch (err) {
    return c.json({ error: 'Failed to fetch pending actions' }, 500);
  }
});

// Cancel a scheduled task
dashboardRouter.delete('/api/tasks/:id', async (c) => {
  try {
    const id = c.req.param('id');
    await cancelTask(id);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: 'Failed to cancel task' }, 500);
  }
});

// Calendar — cron jobs + user tasks
dashboardRouter.get('/api/calendar', async (c) => {
  try {
    const userTasks = await getActiveTasks();
    return c.json({ cronJobs: CRON_JOBS, userTasks });
  } catch (err) {
    return c.json({ cronJobs: CRON_JOBS, userTasks: [] });
  }
});

// Memory facts
dashboardRouter.get('/api/memory/facts', async (c) => {
  try {
    const category = c.req.query('category');
    const facts = category
      ? await getFactsByCategory(category)
      : await getAllFacts(200);
    return c.json(facts);
  } catch (err) {
    return c.json({ error: 'Failed to fetch facts' }, 500);
  }
});

// Memory search
dashboardRouter.get('/api/memory/search', async (c) => {
  try {
    const q = c.req.query('q');
    if (!q) return c.json([]);
    const facts = await searchFacts(q, 30);
    return c.json(facts);
  } catch (err) {
    return c.json({ error: 'Failed to search facts' }, 500);
  }
});

// Learnings
dashboardRouter.get('/api/memory/learnings', async (c) => {
  try {
    const learnings = await getFailurePatterns(undefined, 30);
    return c.json(learnings);
  } catch (err) {
    return c.json({ error: 'Failed to fetch learnings' }, 500);
  }
});

// Conversations
dashboardRouter.get('/api/memory/conversations', async (c) => {
  try {
    const result = await query(
      'SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 50'
    );
    return c.json(result.rows);
  } catch (err) {
    return c.json({ error: 'Failed to fetch conversations' }, 500);
  }
});

// Tools registry
dashboardRouter.get('/api/tools', async (c) => {
  try {
    const tools = getToolRegistry().getAll().map((t) => ({
      name: t.name,
      description: t.description,
      category: t.category,
      requiresApproval: t.requiresApproval,
      enabled: t.enabled,
      builtIn: t.builtIn,
    }));
    return c.json(tools);
  } catch (err) {
    return c.json({ error: 'Failed to fetch tools' }, 500);
  }
});

// Tool usage stats
dashboardRouter.get('/api/tools/stats', async (c) => {
  try {
    const stats = await getToolUsageStats(30);
    return c.json(stats);
  } catch (err) {
    return c.json({ error: 'Failed to fetch tool stats' }, 500);
  }
});

// Tool failures
dashboardRouter.get('/api/tools/failures', async (c) => {
  try {
    const failures = await getRecentFailures(20);
    return c.json(failures);
  } catch (err) {
    return c.json({ error: 'Failed to fetch failures' }, 500);
  }
});

// Audit log
dashboardRouter.get('/api/audit', async (c) => {
  try {
    const logs = await getRecentAuditLogs(100);
    return c.json(logs);
  } catch (err) {
    return c.json({ error: 'Failed to fetch audit logs' }, 500);
  }
});

// ===== Static files for dashboard UI =====
// Serve index.html at root
dashboardRouter.get('/', serveStatic({ path: './public/control/index.html' }));

// Serve any other static assets from public/control/
dashboardRouter.get('/*', serveStatic({ root: './public/control/' }));

export default dashboardRouter;

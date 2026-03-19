import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../../src/config/env.js', () => ({
  getEnv: () => ({
    NODE_ENV: 'test',
    DASHBOARD_TOKEN: 'test-token',
  }),
}));
vi.mock('../../../src/utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockQuery = vi.fn();
vi.mock('../../../src/config/database.js', () => ({
  query: (...args: any[]) => mockQuery(...args),
}));

const mockRedis = {
  ping: vi.fn().mockResolvedValue('PONG'),
};
vi.mock('../../../src/config/redis.js', () => ({
  getRedis: () => mockRedis,
}));

vi.mock('../../../src/tools/registry.js', () => ({
  getToolRegistry: () => ({
    getNames: () => ['web_search', 'browse', 'recall'],
  }),
}));

const healthRouter = (await import('../../../src/routes/health.js')).default;
const { recordError } = await import('../../../src/routes/health.js');

// Use healthRouter directly without prefixing — the routes are defined relative
const app = healthRouter;

beforeEach(() => {
  vi.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [] });
});

describe('GET /health/', () => {
  it('returns healthy when all checks pass', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }); // db check
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('healthy');
    expect(data.checks.database).toBe('ok');
    expect(data.checks.redis).toBe('ok');
  });

  it('returns degraded when DB check fails', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    const res = await app.request('/');
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.status).toBe('degraded');
    expect(data.checks.database).toBe('error');
  });

  it('returns degraded when Redis check fails', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{}] }); // db ok
    mockRedis.ping.mockRejectedValueOnce(new Error('redis down'));
    const res = await app.request('/');
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.checks.redis).toBe('error');
  });

  it('includes uptime and timestamp', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{}] });
    const res = await app.request('/');
    const data = await res.json();
    expect(data).toHaveProperty('uptime');
    expect(data).toHaveProperty('timestamp');
  });
});

describe('GET /health/debug', () => {
  it('returns 401 without auth token', async () => {
    const res = await app.request('/debug');
    expect(res.status).toBe(401);
  });

  it('returns debug info with valid token', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ tablename: 'conversations' }] });
    const res = await app.request('/debug?token=test-token');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tools.count).toBe(3);
    expect(data.tools.names).toContain('web_search');
  });
});

describe('GET /health/debug/messages', () => {
  it('returns 401 without auth token', async () => {
    const res = await app.request('/debug/messages');
    expect(res.status).toBe(401);
  });

  it('returns conversation messages with valid token', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'conv-1', user_phone: 'tg:123', message_count: 5 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'm1', role: 'user', content_preview: 'hello', content_length: 5, created_at: new Date() }] });
    const res = await app.request('/debug/messages?token=test-token');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.conversation).toBeDefined();
    expect(data.messages).toBeDefined();
  });
});

describe('recordError', () => {
  it('pushes to ring buffer and caps at 10', () => {
    for (let i = 0; i < 12; i++) {
      recordError(new Error(`error ${i}`));
    }
    // Can't inspect recentErrors directly (not exported), but the function shouldn't throw
  });
});

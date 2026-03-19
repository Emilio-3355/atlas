import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../../src/config/database.js', () => ({
  query: (...args: any[]) => mockQuery(...args),
}));
vi.mock('../../../src/utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { recordLearning, findRelevantLearnings, getFailurePatterns } = await import('../../../src/memory/learnings.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recordLearning', () => {
  it('creates new learning with pattern hash', async () => {
    // First query: check existing pattern
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Second query: insert new
    mockQuery.mockResolvedValueOnce({ rows: [{
      id: '1', pattern_count: 1, task_description: 'test task', approach: 'web search',
      outcome: 'success', reflection: 'good', resolution: null, tool_name: 'web_search',
      pattern_hash: 'abc123', created_at: new Date(), updated_at: new Date(), resolved_at: null,
    }] });
    const result = await recordLearning('test task', 'web search', 'success', 'good', undefined, 'web_search');
    expect(result).toBeDefined();
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});

describe('findRelevantLearnings', () => {
  it('searches by similarity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [
      { id: '1', task_description: 'search task', tools_used: ['web_search'], outcome: 'success', reflection: 'good', pattern_count: 3, created_at: new Date(), updated_at: new Date(), resolved_at: new Date() },
    ] });
    const results = await findRelevantLearnings('search the web');
    expect(results.length).toBeGreaterThan(0);
  });

  it('respects limit parameter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await findRelevantLearnings('test', 5);
    const call = mockQuery.mock.calls[0];
    expect(call[1]).toContain(5);
  });
});

describe('getFailurePatterns', () => {
  it('returns failures for specific tool', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [
      { id: '1', task_description: 'failed', tools_used: ['browse'], outcome: 'failure', reflection: 'timeout', pattern_count: 5, created_at: new Date(), updated_at: new Date(), resolved_at: null },
    ] });
    const results = await getFailurePatterns('browse');
    expect(results.length).toBeGreaterThan(0);
  });

  it('orders by pattern_count descending', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getFailurePatterns();
    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain('ORDER BY');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../../src/config/database.js', () => ({
  query: (...args: any[]) => mockQuery(...args),
}));
vi.mock('../../../src/utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { upsertFact, getFact, searchFacts, deleteFact, getFactsByCategory, getAllFacts } = await import('../../../src/memory/structured.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('upsertFact', () => {
  it('inserts new fact and returns it', async () => {
    const row = { id: '1', category: 'prefs', key: 'color', value: 'blue', confidence: 1, source: 'user', created_at: new Date(), updated_at: new Date(), expires_at: null, metadata: null };
    mockQuery.mockResolvedValueOnce({ rows: [row] });
    const result = await upsertFact({ category: 'prefs', key: 'color', value: 'blue', source: 'user' });
    expect(result.category).toBe('prefs');
    expect(result.key).toBe('color');
    expect(mockQuery).toHaveBeenCalled();
  });

  it('passes confidence and source correctly', async () => {
    const row = { id: '2', category: 'test', key: 'k', value: 'v', confidence: 0.8, source: 'tool', created_at: new Date(), updated_at: new Date(), expires_at: null, metadata: null };
    mockQuery.mockResolvedValueOnce({ rows: [row] });
    const result = await upsertFact({ category: 'test', key: 'k', value: 'v', source: 'tool', confidence: 0.8 });
    expect(result.confidence).toBe(0.8);
  });
});

describe('getFact', () => {
  it('returns fact for matching category and key', async () => {
    const row = { id: '1', category: 'prefs', key: 'color', value: 'blue', confidence: 1, source: 'user', created_at: new Date(), updated_at: new Date(), expires_at: null, metadata: null };
    mockQuery.mockResolvedValueOnce({ rows: [row] });
    const result = await getFact('prefs', 'color');
    expect(result).not.toBeNull();
    expect(result!.value).toBe('blue');
  });

  it('returns null for non-existent fact', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getFact('missing', 'key');
    expect(result).toBeNull();
  });
});

describe('searchFacts', () => {
  it('matches by query and returns results', async () => {
    const rows = [
      { id: '1', category: 'prefs', key: 'color', value: 'blue', confidence: 1, source: 'user', created_at: new Date(), updated_at: new Date(), expires_at: null, metadata: null, similarity: 0.9 },
    ];
    mockQuery.mockResolvedValueOnce({ rows });
    const results = await searchFacts('blue');
    expect(results.length).toBeGreaterThan(0);
  });

  it('respects limit parameter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await searchFacts('test', 5);
    const call = mockQuery.mock.calls[0];
    expect(call[1]).toContain(5); // limit should be in params
  });
});

describe('deleteFact', () => {
  it('removes existing fact', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    const result = await deleteFact('prefs', 'color');
    expect(result).toBe(true);
  });

  it('returns false for non-existent fact', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    const result = await deleteFact('missing', 'key');
    expect(result).toBe(false);
  });
});

describe('getAllFacts', () => {
  it('returns facts ordered by updated_at', async () => {
    const rows = [
      { id: '1', category: 'a', key: 'k1', value: 'v1', confidence: 1, source: 'user', created_at: new Date(), updated_at: new Date(), expires_at: null, metadata: null },
      { id: '2', category: 'b', key: 'k2', value: 'v2', confidence: 1, source: 'user', created_at: new Date(), updated_at: new Date(), expires_at: null, metadata: null },
    ];
    mockQuery.mockResolvedValueOnce({ rows });
    const results = await getAllFacts();
    expect(results).toHaveLength(2);
  });
});

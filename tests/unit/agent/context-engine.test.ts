import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/config/env.js', () => ({
  getEnv: () => ({ ANTHROPIC_API_KEY: 'test', NODE_ENV: 'test', OPENAI_API_KEY: 'test' }),
}));
vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
}));

const mockSearchFacts = vi.fn().mockResolvedValue([]);
const mockGetFactsByCategory = vi.fn().mockResolvedValue([]);
vi.mock('../../../src/memory/structured.js', () => ({
  searchFacts: (...args: any[]) => mockSearchFacts(...args),
  getFactsByCategory: (...args: any[]) => mockGetFactsByCategory(...args),
}));

const mockHybridSearch = vi.fn().mockResolvedValue([]);
vi.mock('../../../src/memory/semantic.js', () => ({
  hybridSearch: (...args: any[]) => mockHybridSearch(...args),
}));

const mockFindRelevantLearnings = vi.fn().mockResolvedValue([]);
vi.mock('../../../src/memory/learnings.js', () => ({
  findRelevantLearnings: (...args: any[]) => mockFindRelevantLearnings(...args),
}));

vi.mock('../../../src/services/embedding.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(1536).fill(0)),
}));

const { buildContext } = await import('../../../src/agent/context-engine.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildContext', () => {
  it('calls searchFacts, hybridSearch, findRelevantLearnings', async () => {
    await buildContext('test message');
    expect(mockSearchFacts).toHaveBeenCalled();
    expect(mockHybridSearch).toHaveBeenCalled();
    expect(mockFindRelevantLearnings).toHaveBeenCalled();
  });

  it('returns empty strings when no results found', async () => {
    const result = await buildContext('test');
    expect(result.memory).toBe('');
    expect(result.learnings).toBe('');
  });

  it('formats structured facts when found', async () => {
    mockSearchFacts.mockResolvedValueOnce([
      { category: 'prefs', key: 'color', value: 'blue', confidence: 1 },
    ]);
    const result = await buildContext('what is my favorite color');
    expect(result.memory).toContain('prefs');
    expect(result.memory).toContain('blue');
  });

  it('formats learnings when found', async () => {
    mockFindRelevantLearnings.mockResolvedValueOnce([
      { taskDescription: 'search task', outcome: 'success', reflection: 'used web search' },
    ]);
    const result = await buildContext('search for something');
    expect(result.learnings).toContain('search task');
  });

  it('handles all three fetches failing gracefully', async () => {
    mockSearchFacts.mockRejectedValueOnce(new Error('db error'));
    mockHybridSearch.mockRejectedValueOnce(new Error('db error'));
    mockFindRelevantLearnings.mockRejectedValueOnce(new Error('db error'));
    const result = await buildContext('test');
    // Should not throw, should return empty strings
    expect(result.memory).toBe('');
    expect(result.learnings).toBe('');
  });
});

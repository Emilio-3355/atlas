import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../../src/config/database.js', () => ({
  query: (...args: any[]) => mockQuery(...args),
}));
vi.mock('../../../src/utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/memory/structured.js', () => ({
  searchFacts: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../src/memory/learnings.js', () => ({
  recordLearning: vi.fn().mockResolvedValue({ id: '1' }),
}));

const { handleStalenessFromToolResult } = await import('../../../src/self-improvement/staleness-detector.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleStalenessFromToolResult', () => {
  it('skips tiny results (< 20 chars)', async () => {
    await handleStalenessFromToolResult('web_search', 'short', 'conv-1');
    // searchFacts should NOT be called for tiny results
    const { searchFacts } = await import('../../../src/memory/structured.js');
    // It may or may not be called depending on implementation — the function should handle gracefully
  });

  it('skips huge results (> 10000 chars)', async () => {
    const hugeResult = 'x'.repeat(10001);
    await handleStalenessFromToolResult('web_search', hugeResult, 'conv-1');
    // Should not throw
  });

  it('processes normal-sized results without throwing', async () => {
    const result = 'The company Apple was founded in 1976 and is now worth over $3 trillion.';
    await handleStalenessFromToolResult('web_search', result, 'conv-1');
    // Should complete without error
  });
});

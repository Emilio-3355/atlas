import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────

vi.mock('../../../src/utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockSearchFacts = vi.fn().mockResolvedValue([]);
const mockGetAllFacts = vi.fn().mockResolvedValue([]);
const mockGetFactsByCategory = vi.fn().mockResolvedValue([]);

vi.mock('../../../src/memory/structured.js', () => ({
  getAllFacts: (...args: any[]) => mockGetAllFacts(...args),
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

vi.mock('../../../src/memory/conversation.js', () => ({
  searchPastConversations: vi.fn().mockResolvedValue([]),
}));

// ─── Test Suite ──────────────────────────────────────────────────

describe('context-engine.ts — adversarial deep tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchFacts.mockResolvedValue([]);
    mockHybridSearch.mockResolvedValue([]);
    mockFindRelevantLearnings.mockResolvedValue([]);
    mockGetFactsByCategory.mockResolvedValue([]);
  });

  // ═══ Basic Structure ═══

  describe('buildContext return structure', () => {
    it('returns { memory, learnings, behavioralRules }', async () => {
      const { buildContext } = await import('../../../src/agent/context-engine.js');
      const result = await buildContext('hello');

      expect(result).toHaveProperty('memory');
      expect(result).toHaveProperty('learnings');
      expect(result).toHaveProperty('behavioralRules');
      expect(typeof result.memory).toBe('string');
      expect(typeof result.learnings).toBe('string');
      expect(typeof result.behavioralRules).toBe('string');
    });

    it('empty results produce empty strings', async () => {
      const { buildContext } = await import('../../../src/agent/context-engine.js');
      const result = await buildContext('test query');

      expect(result.memory).toBe('');
      expect(result.learnings).toBe('');
      expect(result.behavioralRules).toBe('');
    });
  });

  // ═══ Behavioral Rules ═══

  describe('behavioralRules are separate from memory', () => {
    it('behavioral_rule category facts appear in behavioralRules, not memory', async () => {
      mockSearchFacts.mockResolvedValue([
        { category: 'behavioral_rule', key: 'rule1', value: 'Never do X', updatedAt: '2026-01-01' },
        { category: 'preference', key: 'pref1', value: 'likes dark mode', updatedAt: '2026-01-01' },
      ]);
      mockGetFactsByCategory.mockResolvedValue([
        { category: 'behavioral_rule', key: 'rule1', value: 'Never do X', updatedAt: '2026-01-01' },
      ]);

      const { buildContext } = await import('../../../src/agent/context-engine.js');
      const result = await buildContext('query');

      // Rules should be in behavioralRules
      expect(result.behavioralRules).toContain('Never do X');

      // behavioral_rule facts should be EXCLUDED from memory section
      expect(result.memory).not.toContain('behavioral_rule');
      // But other facts should be in memory
      expect(result.memory).toContain('likes dark mode');
    });

    it('rules are sorted by updatedAt DESC (most recent first)', async () => {
      mockGetFactsByCategory.mockResolvedValue([
        { category: 'behavioral_rule', key: 'old', value: 'Old rule', updatedAt: '2025-01-01' },
        { category: 'behavioral_rule', key: 'new', value: 'New rule', updatedAt: '2026-03-01' },
        { category: 'behavioral_rule', key: 'mid', value: 'Mid rule', updatedAt: '2025-06-15' },
      ]);

      const { buildContext } = await import('../../../src/agent/context-engine.js');
      const result = await buildContext('query');

      const newIdx = result.behavioralRules.indexOf('New rule');
      const midIdx = result.behavioralRules.indexOf('Mid rule');
      const oldIdx = result.behavioralRules.indexOf('Old rule');

      expect(newIdx).toBeLessThan(midIdx);
      expect(midIdx).toBeLessThan(oldIdx);
    });

    it('rules budget: MAX_RULES_TOKENS * 4 = 12000 chars', async () => {
      // Create rules that exceed 12000 chars total (MAX_RULES_TOKENS=3000 * 4)
      const longRules = Array.from({ length: 150 }, (_, i) => ({
        category: 'behavioral_rule',
        key: `rule_${i}`,
        value: `This is rule number ${i} and it contains some verbose text to fill up space: ${'x'.repeat(100)}`,
        updatedAt: new Date(2026, 0, 1 + i).toISOString(),
      }));

      mockGetFactsByCategory.mockResolvedValue(longRules);

      const { buildContext } = await import('../../../src/agent/context-engine.js');
      const result = await buildContext('query');

      // Should be capped — not all 150 rules should appear
      // MAX_RULES_TOKENS * 4 = 12000, each rule ~120 chars → about 100 rules max
      expect(result.behavioralRules.length).toBeLessThanOrEqual(12100); // small tolerance for last line
      expect(result.behavioralRules.length).toBeGreaterThan(0);
    });

    it('rules are NEVER truncated mid-rule (whole lines only)', async () => {
      const rules = Array.from({ length: 40 }, (_, i) => ({
        category: 'behavioral_rule',
        key: `rule_${i}`,
        value: `Rule ${i}: ${'a'.repeat(100)}`,
        updatedAt: new Date(2026, 0, 1 + i).toISOString(),
      }));

      mockGetFactsByCategory.mockResolvedValue(rules);

      const { buildContext } = await import('../../../src/agent/context-engine.js');
      const result = await buildContext('query');

      // Each line should be complete (starts with bullet, ends properly)
      const lines = result.behavioralRules.split('\n').filter(l => l.trim());
      for (const line of lines) {
        expect(line).toMatch(/^• Rule \d+:/);
      }
    });
  });

  // ═══ Memory Budget ═══

  describe('memory budget', () => {
    it('memory budget: MAX_MEMORY_TOKENS * 4 = 32000 chars, then truncated', async () => {
      // Create enough facts to exceed 32000 chars (MAX_MEMORY_TOKENS=8000 * 4)
      const manyFacts = Array.from({ length: 300 }, (_, i) => ({
        category: 'knowledge',
        key: `fact_${i}`,
        value: `This is fact number ${i} with extra content: ${'y'.repeat(150)}`,
        updatedAt: '2026-01-01',
      }));

      mockSearchFacts.mockResolvedValue(manyFacts);

      const { buildContext } = await import('../../../src/agent/context-engine.js');
      const result = await buildContext('query');

      // Memory should be truncated
      expect(result.memory).toContain('...(memory truncated)');
      // Total length should be around 32000 + truncation notice
      expect(result.memory.length).toBeLessThanOrEqual(32100);
    });

    it('memory truncation does NOT affect behavioralRules', async () => {
      // Huge memory + some rules
      const manyFacts = Array.from({ length: 300 }, (_, i) => ({
        category: 'knowledge',
        key: `fact_${i}`,
        value: `Fact: ${'z'.repeat(200)}`,
        updatedAt: '2026-01-01',
      }));

      mockSearchFacts.mockResolvedValue(manyFacts);
      mockGetFactsByCategory.mockResolvedValue([
        { category: 'behavioral_rule', key: 'critical', value: 'Never delete user data', updatedAt: '2026-03-01' },
      ]);

      const { buildContext } = await import('../../../src/agent/context-engine.js');
      const result = await buildContext('query');

      // Memory should be truncated
      expect(result.memory).toContain('...(memory truncated)');
      // Rules should be intact and separate
      expect(result.behavioralRules).toContain('Never delete user data');
      expect(result.behavioralRules).not.toContain('truncated');
    });
  });

  // ═══ Promise.allSettled Resilience ═══

  describe('Promise.allSettled resilience', () => {
    it('if searchFacts throws, other sources still work', async () => {
      mockSearchFacts.mockRejectedValue(new Error('DB connection lost'));
      mockHybridSearch.mockResolvedValue([
        { content: 'semantic memory works', score: 0.85 },
      ]);
      mockFindRelevantLearnings.mockResolvedValue([
        { taskDescription: 'some task', outcome: 'success', resolution: 'did X' },
      ]);

      const { buildContext } = await import('../../../src/agent/context-engine.js');
      const result = await buildContext('query');

      expect(result.memory).toContain('semantic memory works');
      expect(result.learnings).toContain('some task');
    });

    it('if hybridSearch throws, other sources still work', async () => {
      mockHybridSearch.mockRejectedValue(new Error('vector DB down'));
      mockSearchFacts.mockResolvedValue([
        { category: 'knowledge', key: 'k1', value: 'structured fact works', updatedAt: '2026-01-01' },
      ]);

      const { buildContext } = await import('../../../src/agent/context-engine.js');
      const result = await buildContext('query');

      expect(result.memory).toContain('structured fact works');
      expect(result.memory).not.toContain('Related Memories');
    });

    it('if getFactsByCategory throws, memory still works (rules just empty)', async () => {
      mockGetFactsByCategory.mockRejectedValue(new Error('table missing'));
      mockSearchFacts.mockResolvedValue([
        { category: 'knowledge', key: 'k1', value: 'fact here', updatedAt: '2026-01-01' },
      ]);

      const { buildContext } = await import('../../../src/agent/context-engine.js');
      const result = await buildContext('query');

      expect(result.memory).toContain('fact here');
      expect(result.behavioralRules).toBe('');
    });

    it('if ALL sources throw, returns empty strings for everything', async () => {
      mockSearchFacts.mockRejectedValue(new Error('fail'));
      mockHybridSearch.mockRejectedValue(new Error('fail'));
      mockFindRelevantLearnings.mockRejectedValue(new Error('fail'));
      mockGetFactsByCategory.mockRejectedValue(new Error('fail'));

      const { buildContext } = await import('../../../src/agent/context-engine.js');
      const result = await buildContext('query');

      expect(result.memory).toBe('');
      expect(result.learnings).toBe('');
      expect(result.behavioralRules).toBe('');
    });
  });

  // ═══ Learnings ═══

  describe('learnings formatting', () => {
    it('learnings include resolution when present', async () => {
      mockFindRelevantLearnings.mockResolvedValue([
        { taskDescription: 'deploy to prod', outcome: 'failure', resolution: 'fixed env vars' },
      ]);

      const { buildContext } = await import('../../../src/agent/context-engine.js');
      const result = await buildContext('deployment');

      expect(result.learnings).toContain('deploy to prod');
      expect(result.learnings).toContain('failure');
      expect(result.learnings).toContain('Lesson: fixed env vars');
    });

    it('learnings omit resolution line when resolution is absent', async () => {
      mockFindRelevantLearnings.mockResolvedValue([
        { taskDescription: 'send email', outcome: 'success' },
      ]);

      const { buildContext } = await import('../../../src/agent/context-engine.js');
      const result = await buildContext('email');

      expect(result.learnings).toContain('send email');
      expect(result.learnings).toContain('success');
      expect(result.learnings).not.toContain('Lesson:');
    });
  });

  // ═══ Semantic Memory ═══

  describe('semantic memory formatting', () => {
    it('includes relevance score as percentage', async () => {
      mockHybridSearch.mockResolvedValue([
        { content: 'JP prefers dark mode', score: 0.92 },
      ]);

      const { buildContext } = await import('../../../src/agent/context-engine.js');
      const result = await buildContext('preferences');

      expect(result.memory).toContain('JP prefers dark mode');
      expect(result.memory).toContain('92%');
    });
  });

  // ═══ BUG: No Dedup for Behavioral Rules ═══

  describe('BUG: behavioralRules has no dedup', () => {
    /**
     * DOCUMENTED BUG: If the same rule is stored twice with different keys
     * (e.g., key="never_delete" and key="no_deletion"), both appear in the
     * behavioralRules string. There's no content-based deduplication.
     *
     * Impact: Wastes the rules budget (MAX_RULES_TOKENS * 4 = 12000 chars)
     * with duplicate information. In the worst case, a single rule stored
     * under many keys could fill the entire budget, crowding out other rules.
     *
     * Fix: Deduplicate by value (or normalized value) before building the string.
     */
    it('duplicate rules with different keys appear twice (SHOULD FAIL if dedup is added)', async () => {
      mockGetFactsByCategory.mockResolvedValue([
        { category: 'behavioral_rule', key: 'rule_v1', value: 'Never delete user data without confirmation', updatedAt: '2026-01-15' },
        { category: 'behavioral_rule', key: 'rule_v2', value: 'Never delete user data without confirmation', updatedAt: '2026-02-01' },
      ]);

      const { buildContext } = await import('../../../src/agent/context-engine.js');
      const result = await buildContext('query');

      // Count occurrences — currently both appear (no dedup)
      const occurrences = result.behavioralRules.split('Never delete user data without confirmation').length - 1;

      // This PASSES today because there's no dedup — documenting the bug
      // When dedup is added, this test should be updated to expect(occurrences).toBe(1)
      expect(occurrences).toBe(2);
    });
  });

  // ═══ Edge Cases ═══

  describe('edge cases', () => {
    it('passes user message to searchFacts and hybridSearch', async () => {
      const { buildContext } = await import('../../../src/agent/context-engine.js');
      await buildContext('what is the weather in NYC');

      expect(mockSearchFacts).toHaveBeenCalledWith('what is the weather in NYC', 15);
      expect(mockHybridSearch).toHaveBeenCalledWith('what is the weather in NYC', 15);
      expect(mockFindRelevantLearnings).toHaveBeenCalledWith('what is the weather in NYC', 8);
    });

    it('getFactsByCategory is called with "behavioral_rule"', async () => {
      const { buildContext } = await import('../../../src/agent/context-engine.js');
      await buildContext('anything');

      expect(mockGetFactsByCategory).toHaveBeenCalledWith('behavioral_rule');
    });
  });
});

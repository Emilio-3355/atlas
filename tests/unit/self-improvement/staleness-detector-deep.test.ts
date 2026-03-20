import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../../src/config/database.js', () => ({
  query: (...args: any[]) => mockQuery(...args),
}));
vi.mock('../../../src/utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockSearchFacts = vi.fn();
const mockUpsertFact = vi.fn();
vi.mock('../../../src/memory/structured.js', () => ({
  searchFacts: (...args: any[]) => mockSearchFacts(...args),
  upsertFact: (...args: any[]) => mockUpsertFact(...args),
}));

const mockRecordLearning = vi.fn();
vi.mock('../../../src/memory/learnings.js', () => ({
  recordLearning: (...args: any[]) => mockRecordLearning(...args),
}));

const { detectStaleness, handleStalenessFromToolResult, getStalenessReport } = await import(
  '../../../src/self-improvement/staleness-detector.js'
);

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// detectStaleness TESTS
// ============================================================================

describe('detectStaleness', () => {
  it('returns empty array when DB has no stale facts', async () => {
    // 6 categories → 6 queries, all returning empty
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await detectStaleness();
    expect(result).toEqual([]);
    // Should have queried once per category in STALENESS_THRESHOLDS
    // Categories: contact(180), preference(90), schedule(7), booking(1), finance(30), general(60)
    expect(mockQuery).toHaveBeenCalledTimes(6);
  });

  it('returns stale signals for facts exceeding their category threshold', async () => {
    // First query (contact, threshold 180) returns a stale fact
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'fact-1',
            category: 'contact',
            key: 'john_email',
            value: 'john@old.com',
            source: 'manual',
            confidence: 0.9,
            updated_at: new Date(Date.now() - 200 * 86400000),
            days_since_update: 200,
          },
        ],
      })
      // Remaining 5 categories return empty
      .mockResolvedValue({ rows: [] });

    // The update query for reducing confidence
    // (detectStaleness updates confidence after collecting signals)

    const result = await detectStaleness();
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].factKey).toBe('john_email');
    expect(result[0].daysSinceUpdate).toBe(200);
  });

  it('reduces confidence using GREATEST(confidence * 0.8, 0.3) formula', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'fact-1',
            category: 'contact',
            key: 'test_key',
            value: 'test_value',
            confidence: 0.5,
            updated_at: new Date(),
            days_since_update: 200,
          },
        ],
      })
      .mockResolvedValue({ rows: [] });

    await detectStaleness();

    // Should have called UPDATE with the GREATEST formula
    const updateCalls = mockQuery.mock.calls.filter((call: any[]) =>
      typeof call[0] === 'string' && call[0].includes('GREATEST')
    );
    expect(updateCalls.length).toBeGreaterThan(0);
    expect(updateCalls[0][0]).toContain('confidence * 0.8');
    expect(updateCalls[0][0]).toContain('0.3');
  });

  it('confidence floor is 0.3 — never updates facts already at 0.3', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'fact-1',
            category: 'contact',
            key: 'already_low',
            value: 'val',
            confidence: 0.3,
            updated_at: new Date(),
            days_since_update: 365,
          },
        ],
      })
      .mockResolvedValue({ rows: [] });

    await detectStaleness();

    // The UPDATE query has WHERE confidence > 0.3, so facts at exactly 0.3 are skipped
    const updateCalls = mockQuery.mock.calls.filter((call: any[]) =>
      typeof call[0] === 'string' && call[0].includes('UPDATE')
    );
    if (updateCalls.length > 0) {
      expect(updateCalls[0][0]).toContain('confidence > 0.3');
    }
  });

  it('queries each category with its specific threshold', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await detectStaleness();

    const thresholds: Record<string, number> = {
      contact: 180,
      preference: 90,
      schedule: 7,
      booking: 1,
      finance: 30,
      general: 60,
    };

    const selectCalls = mockQuery.mock.calls.filter((call: any[]) =>
      typeof call[0] === 'string' && call[0].includes('memory_facts')
    );

    // Verify each category was queried with the right threshold
    for (const [category, threshold] of Object.entries(thresholds)) {
      const matchingCall = selectCalls.find(
        (call: any[]) => call[1] && call[1][0] === category && call[1][1] === threshold
      );
      expect(matchingCall).toBeDefined();
    }
  });

  it('limits results to 10 per category', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await detectStaleness();

    // All SELECT queries should have LIMIT 10
    const selectCalls = mockQuery.mock.calls.filter((call: any[]) =>
      typeof call[0] === 'string' && call[0].includes('SELECT')
    );
    for (const call of selectCalls) {
      expect(call[0]).toContain('LIMIT 10');
    }
  });
});

// ============================================================================
// handleStalenessFromToolResult TESTS
// ============================================================================

describe('handleStalenessFromToolResult', () => {
  it('returns early for unknown tools (not in KNOWLEDGE_TOOLS)', async () => {
    await handleStalenessFromToolResult('send_email', 'some result data here that is long enough', 'conv-1');
    expect(mockSearchFacts).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns early for "calculator" tool (not in KNOWLEDGE_TOOLS)', async () => {
    await handleStalenessFromToolResult('calculator', 'result that is at least twenty chars', 'conv-1');
    expect(mockSearchFacts).not.toHaveBeenCalled();
  });

  it('skips tool results shorter than 20 chars', async () => {
    await handleStalenessFromToolResult('web_search', 'short', 'conv-1');
    expect(mockSearchFacts).not.toHaveBeenCalled();
  });

  it('skips tool results longer than 10000 chars', async () => {
    const hugeResult = 'x'.repeat(10001);
    await handleStalenessFromToolResult('web_search', hugeResult, 'conv-1');
    expect(mockSearchFacts).not.toHaveBeenCalled();
  });

  it('skips result of exactly 19 chars (boundary)', async () => {
    await handleStalenessFromToolResult('web_search', 'a'.repeat(19), 'conv-1');
    expect(mockSearchFacts).not.toHaveBeenCalled();
  });

  it('processes result of exactly 20 chars (boundary)', async () => {
    mockSearchFacts.mockResolvedValueOnce([]);
    await handleStalenessFromToolResult('web_search', 'a'.repeat(20), 'conv-1');
    expect(mockSearchFacts).toHaveBeenCalled();
  });

  it('processes result of exactly 10000 chars (boundary)', async () => {
    mockSearchFacts.mockResolvedValueOnce([]);
    await handleStalenessFromToolResult('web_search', 'a'.repeat(10000), 'conv-1');
    expect(mockSearchFacts).toHaveBeenCalled();
  });

  it('processes valid web_search result and queries searchFacts', async () => {
    mockSearchFacts.mockResolvedValueOnce([]);
    const data = 'Apple Inc reported Q4 earnings of $1.50 per share, beating estimates by $0.10';
    await handleStalenessFromToolResult('web_search', data, 'conv-1');
    expect(mockSearchFacts).toHaveBeenCalledWith(expect.any(String), 5);
  });

  it('processes browse tool results', async () => {
    mockSearchFacts.mockResolvedValueOnce([]);
    const data = 'The restaurant has moved to a new location at 456 Broadway, New York.';
    await handleStalenessFromToolResult('browse', data, 'conv-1');
    expect(mockSearchFacts).toHaveBeenCalled();
  });

  it('processes recall tool results', async () => {
    mockSearchFacts.mockResolvedValueOnce([]);
    const data = 'Previously stored: JP prefers morning meetings on Tuesdays and Thursdays';
    await handleStalenessFromToolResult('recall', data, 'conv-1');
    expect(mockSearchFacts).toHaveBeenCalled();
  });

  it('confirms KNOWLEDGE_TOOLS includes all expected tools', async () => {
    // We verify by checking that each known tool is processed (calls searchFacts)
    const expectedTools = ['web_search', 'browse', 'read_email', 'calendar_read', 'recall'];
    const data = 'This is a test string that is long enough to pass the 20 char minimum check.';

    for (const tool of expectedTools) {
      vi.clearAllMocks();
      mockSearchFacts.mockResolvedValueOnce([]);
      await handleStalenessFromToolResult(tool, data, 'conv-1');
      expect(mockSearchFacts).toHaveBeenCalled();
    }
  });

  it('confirms send_email is NOT in KNOWLEDGE_TOOLS', async () => {
    const data = 'This is a test string that is long enough to pass the 20 char minimum check.';
    await handleStalenessFromToolResult('send_email', data, 'conv-1');
    expect(mockSearchFacts).not.toHaveBeenCalled();
  });

  it('flags facts older than 50% of their threshold and reduces confidence', async () => {
    const oldDate = new Date(Date.now() - 100 * 86400000); // 100 days ago
    mockSearchFacts.mockResolvedValueOnce([
      {
        id: 'fact-1',
        category: 'general', // threshold 60 days, 50% = 30 days. 100 > 30 → flagged
        key: 'company_address',
        value: '123 Old Street',
        updatedAt: oldDate.toISOString(),
      },
    ]);
    mockQuery.mockResolvedValue({ rows: [] });
    mockRecordLearning.mockResolvedValue({ id: '1' });

    const data = 'The company is now located at 456 New Avenue, according to their updated website.';
    await handleStalenessFromToolResult('web_search', data, 'conv-1');

    // Should update confidence in DB
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('GREATEST'),
      expect.arrayContaining(['fact-1'])
    );

    // Should record a learning
    expect(mockRecordLearning).toHaveBeenCalled();
  });

  it('does NOT flag recent facts (within 50% of threshold)', async () => {
    const recentDate = new Date(Date.now() - 5 * 86400000); // 5 days ago
    mockSearchFacts.mockResolvedValueOnce([
      {
        id: 'fact-2',
        category: 'general', // threshold 60, 50% = 30 days. 5 < 30 → not flagged
        key: 'recent_fact',
        value: 'some recent info',
        updatedAt: recentDate.toISOString(),
      },
    ]);

    const data = 'Some search result that mentions something potentially related to the fact.';
    await handleStalenessFromToolResult('web_search', data, 'conv-1');

    // Should NOT update confidence — fact is fresh
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockRecordLearning).not.toHaveBeenCalled();
  });

  it('handles JSON object as toolData (not just string)', async () => {
    mockSearchFacts.mockResolvedValueOnce([]);
    const data = { title: 'Search Result', snippet: 'Some information about the query topic that is relevant.' };
    await handleStalenessFromToolResult('web_search', data, 'conv-1');
    // Should JSON.stringify the object and proceed
    expect(mockSearchFacts).toHaveBeenCalled();
  });

  it('does not throw when searchFacts throws (non-critical path)', async () => {
    mockSearchFacts.mockRejectedValueOnce(new Error('DB down'));
    const data = 'A normal search result that should not cause the function to crash entirely.';
    // Should not throw — the error is caught internally
    await expect(
      handleStalenessFromToolResult('web_search', data, 'conv-1')
    ).resolves.toBeUndefined();
  });
});

// ============================================================================
// getStalenessReport TESTS
// ============================================================================

describe('getStalenessReport', () => {
  it('returns empty string when no low-confidence facts exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const report = await getStalenessReport();
    expect(report).toBe('');
  });

  it('returns formatted report with category, key, value, confidence, and age', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          category: 'contact',
          key: 'john_email',
          value: 'john@old.com',
          confidence: 0.4,
          days_since_update: 200,
        },
        {
          category: 'finance',
          key: 'btc_price',
          value: '$45000',
          confidence: 0.3,
          days_since_update: 90,
        },
      ],
    });

    const report = await getStalenessReport();

    expect(report).toContain('[contact]');
    expect(report).toContain('john_email');
    expect(report).toContain('john@old.com');
    expect(report).toContain('40%');
    expect(report).toContain('200d');

    expect(report).toContain('[finance]');
    expect(report).toContain('btc_price');
    expect(report).toContain('30%');
  });

  it('includes header line in report', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          category: 'general',
          key: 'some_fact',
          value: 'some value',
          confidence: 0.5,
          days_since_update: 100,
        },
      ],
    });

    const report = await getStalenessReport();
    expect(report).toContain('Potentially Stale Facts');
  });

  it('truncates long values to 60 chars', async () => {
    const longValue = 'A'.repeat(100);
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          category: 'general',
          key: 'long_fact',
          value: longValue,
          confidence: 0.5,
          days_since_update: 80,
        },
      ],
    });

    const report = await getStalenessReport();
    // The value in the report should be truncated — the source does .slice(0, 60)
    expect(report).not.toContain(longValue);
    expect(report).toContain('A'.repeat(60));
  });

  it('queries only facts with confidence < 0.7', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getStalenessReport();

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('confidence < 0.7'),
    );
  });

  it('limits results to 15', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getStalenessReport();

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('LIMIT 15'),
    );
  });
});

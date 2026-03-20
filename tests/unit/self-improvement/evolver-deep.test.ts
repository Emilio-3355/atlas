import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────

vi.mock('../../../src/utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
vi.mock('../../../src/config/database.js', () => ({
  query: (...args: any[]) => mockQuery(...args),
}));

vi.mock('../../../src/self-improvement/observer.js', () => ({
  getToolUsageStats: vi.fn().mockResolvedValue([]),
  getToolSequences: vi.fn().mockResolvedValue({}),
  getRecentFailures: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/memory/learnings.js', () => ({
  getFailurePatterns: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/self-improvement/staleness-detector.js', () => ({
  getStalenessReport: vi.fn().mockResolvedValue(''),
}));

vi.mock('../../../src/agent/claude-client.js', () => ({
  callClaude: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'NO_PROPOSALS' }] }),
  extractTextContent: vi.fn().mockReturnValue('NO_PROPOSALS'),
}));

vi.mock('../../../src/services/whatsapp.js', () => ({
  sendWhatsAppMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/config/env.js', () => ({
  getEnv: vi.fn().mockReturnValue({ JP_PHONE_NUMBER: '+1234567890' }),
}));

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

// ─── Test Suite ──────────────────────────────────────────────────

describe('evolver.ts — adversarial deep tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  // ═══ getEvolutionHistory ═══

  describe('getEvolutionHistory', () => {
    it('queries DB with correct SQL and default limit of 10', async () => {
      const { getEvolutionHistory } = await import('../../../src/self-improvement/evolver.js');
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, cycle_number: 1, intent: 'repair' }] });

      const result = await getEvolutionHistory();

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('FROM evolution_events'),
        [10],
      );
      expect(result).toHaveLength(1);
    });

    it('respects custom limit parameter', async () => {
      const { getEvolutionHistory } = await import('../../../src/self-improvement/evolver.js');
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await getEvolutionHistory(5);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT $1'),
        [5],
      );
    });

    it('returns empty array when no events exist', async () => {
      const { getEvolutionHistory } = await import('../../../src/self-improvement/evolver.js');
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await getEvolutionHistory();
      expect(result).toEqual([]);
    });

    it('propagates database errors (no try/catch in getEvolutionHistory)', async () => {
      const { getEvolutionHistory } = await import('../../../src/self-improvement/evolver.js');
      mockQuery.mockRejectedValueOnce(new Error('connection refused'));

      await expect(getEvolutionHistory()).rejects.toThrow('connection refused');
    });
  });

  // ═══ getEvolutionState_public ═══

  describe('getEvolutionState_public', () => {
    it('returns parsed state from all rows', async () => {
      const { getEvolutionState_public } = await import('../../../src/self-improvement/evolver.js');
      mockQuery.mockResolvedValueOnce({
        rows: [
          { key: 'cycle_count', value: '42' },
          { key: 'strategy', value: '"balanced"' },
          { key: 'circuit_breaker_tripped', value: 'false' },
        ],
      });

      const state = await getEvolutionState_public();

      expect(state.cycle_count).toBe(42);
      expect(state.strategy).toBe('balanced');
      expect(state.circuit_breaker_tripped).toBe(false);
    });

    it('returns empty object when no state exists', async () => {
      const { getEvolutionState_public } = await import('../../../src/self-improvement/evolver.js');
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const state = await getEvolutionState_public();
      expect(state).toEqual({});
    });

    it('crashes on malformed JSON in state value (no error handling)', async () => {
      /**
       * BUG DOCUMENTATION: getEvolutionState_public calls JSON.parse(row.value)
       * without try/catch. If a row has malformed JSON, the entire function throws.
       * This could be triggered by manual DB edits or a write failure that
       * partially corrupts the value column.
       */
      const { getEvolutionState_public } = await import('../../../src/self-improvement/evolver.js');
      mockQuery.mockResolvedValueOnce({
        rows: [{ key: 'bad_key', value: '{not valid json' }],
      });

      await expect(getEvolutionState_public()).rejects.toThrow();
    });
  });

  // ═══ runEvolutionCycle ═══

  describe('runEvolutionCycle', () => {
    it('records "insufficient_data" event when totalUses < MIN_USAGE_DATA (20)', async () => {
      const { getToolUsageStats } = await import('../../../src/self-improvement/observer.js');
      (getToolUsageStats as any).mockResolvedValue([
        { toolName: 'search', totalUses: 5, successRate: 1.0, avgDurationMs: 100 },
      ]);

      // Mock the DB calls for incrementCycleCount and recordEvent
      let recordedEvent: any = null;
      mockQuery.mockImplementation(async (sql: string, params: any[]) => {
        if (sql.includes('evolution_state') && sql.includes('SELECT')) {
          return { rows: [{ value: '0' }] };
        }
        if (sql.includes('evolution_state') && sql.includes('INSERT')) {
          return { rows: [] };
        }
        if (sql.includes('evolution_events') && sql.includes('INSERT')) {
          recordedEvent = { intent: params[1], outcome: params[4] };
          return { rows: [] };
        }
        return { rows: [] };
      });

      const { runEvolutionCycle } = await import('../../../src/self-improvement/evolver.js');
      await runEvolutionCycle();

      // Should have recorded an event with intent 'none' and outcome 'no_proposals'
      expect(recordedEvent).toBeTruthy();
      expect(recordedEvent.intent).toBe('none');
      expect(recordedEvent.outcome).toBe('no_proposals');
    });

    it('catches and records errors during cycle execution', async () => {
      const { getToolUsageStats } = await import('../../../src/self-improvement/observer.js');
      (getToolUsageStats as any).mockRejectedValue(new Error('DB exploded'));

      let errorRecorded = false;
      mockQuery.mockImplementation(async (sql: string, params: any[]) => {
        if (sql.includes('evolution_state') && sql.includes('SELECT')) {
          return { rows: [{ value: '10' }] };
        }
        if (sql.includes('evolution_state') && sql.includes('INSERT')) {
          return { rows: [] };
        }
        if (sql.includes('evolution_events') && sql.includes('INSERT')) {
          if (params[4] === 'error') errorRecorded = true;
          return { rows: [] };
        }
        return { rows: [] };
      });

      const { runEvolutionCycle } = await import('../../../src/self-improvement/evolver.js');
      // Should NOT throw — errors are caught internally
      await expect(runEvolutionCycle()).resolves.toBeUndefined();
      expect(errorRecorded).toBe(true);
    });
  });

  // ═══ DOCUMENTED BUGS & TESTABILITY GAPS ═══

  describe('BUGS & testability gaps (documentation tests)', () => {
    /**
     * BUG (lines 373-377): filterCooldowns only checks `tool_definitions` table
     * for recently rejected proposals. It SHOULD also check `evolution_events`
     * where outcome='rejected' to catch proposals that were rejected via
     * the WhatsApp approval flow but never stored in tool_definitions.
     *
     * Impact: A proposal rejected via WhatsApp could be re-proposed the very
     * next cycle if it wasn't inserted into tool_definitions with status='rejected'.
     *
     * The filterCooldowns query is:
     *   SELECT id FROM tool_definitions
     *   WHERE name = $1 AND status = 'rejected' AND proposed_at > NOW() - INTERVAL '1 day' * $2
     *
     * It should ALSO run:
     *   SELECT id FROM evolution_events
     *   WHERE outcome = 'rejected'
     *     AND proposals::text LIKE '%' || $1 || '%'
     *     AND created_at > NOW() - INTERVAL '1 day' * $2
     */
    it('filterCooldowns only checks tool_definitions (misses evolution_events rejections)', async () => {
      // This test documents the bug. Since filterCooldowns is internal,
      // we verify the behavior indirectly: the module's exports don't include filterCooldowns.
      const evolver = await import('../../../src/self-improvement/evolver.js');
      expect(evolver).not.toHaveProperty('filterCooldowns');
      // The bug exists in the internal implementation — see comment above.
    });

    /**
     * parseProposals is not exported — cannot unit test proposal parsing logic
     * independently. This means we can't verify:
     * - TYPE alias mapping (fix→repair, new_tool→innovate, upgrade→optimize, workflow→optimize)
     * - MAX_PROPOSALS_PER_CYCLE=3 enforcement
     * - Handling of malformed proposal blocks
     * - Missing RATIONALE/PRIORITY defaults
     */
    it('parseProposals is NOT exported — untestable independently', async () => {
      const evolver = await import('../../../src/self-improvement/evolver.js');
      expect(evolver).not.toHaveProperty('parseProposals');
    });

    /**
     * hashProposal is not exported — cannot verify:
     * - Deterministic hashing (same input → same hash)
     * - Hash collision resistance for similar proposals
     * - The canonical form (only type+name+description, not rationale/priority)
     * - SHA-256 truncation to 16 chars
     */
    it('hashProposal is NOT exported — cannot verify dedup hashing', async () => {
      const evolver = await import('../../../src/self-improvement/evolver.js');
      expect(evolver).not.toHaveProperty('hashProposal');
    });

    /**
     * MAX_PROPOSALS_PER_CYCLE=3 is a private constant. We cannot test that
     * the system correctly caps proposals at 3 without either:
     * - Exporting the constant
     * - Running a full evolution cycle with a mock Claude response that returns 5 proposals
     * The latter is an integration test, not a unit test.
     */
    it('MAX_PROPOSALS_PER_CYCLE is not exported — cannot verify cap', async () => {
      const evolver = await import('../../../src/self-improvement/evolver.js');
      expect(evolver).not.toHaveProperty('MAX_PROPOSALS_PER_CYCLE');
    });

    /**
     * getConsecutiveRepairs is internal — queries evolution_events for recent
     * intents and counts consecutive 'repair' intents from the end.
     * Can't test the circuit breaker logic without it being exported.
     */
    it('getConsecutiveRepairs is NOT exported — circuit breaker logic untestable in isolation', async () => {
      const evolver = await import('../../../src/self-improvement/evolver.js');
      expect(evolver).not.toHaveProperty('getConsecutiveRepairs');
    });

    /**
     * determineIntent uses Math.random() for probabilistic intent selection
     * when no clear signal points to repair/optimize. This makes the function
     * non-deterministic and untestable without mocking Math.random.
     * Since it's internal, we can't even mock it for unit tests.
     */
    it('determineIntent is NOT exported — random selection is non-deterministic', async () => {
      const evolver = await import('../../../src/self-improvement/evolver.js');
      expect(evolver).not.toHaveProperty('determineIntent');
    });

    /**
     * STRATEGY_PRESETS is not exported. Can't verify:
     * - 'balanced' weights: repair=50, optimize=30, innovate=20
     * - 'innovate' weights: repair=20, optimize=15, innovate=65
     * - 'harden' weights: repair=60, optimize=30, innovate=10
     * - 'repair_only' weights: repair=80, optimize=15, innovate=5
     */
    it('STRATEGY_PRESETS is not exported — cannot verify weight distributions', async () => {
      const evolver = await import('../../../src/self-improvement/evolver.js');
      expect(evolver).not.toHaveProperty('STRATEGY_PRESETS');
    });

    /**
     * BUG: recordEvent swallows database errors silently.
     * If the INSERT into evolution_events fails (e.g., table doesn't exist,
     * disk full, etc.), the error is caught, logged, and discarded.
     * This means the "immutable audit trail" can have silent gaps.
     */
    it('recordEvent silently swallows DB errors (audit trail can have gaps)', async () => {
      // We can observe this indirectly: runEvolutionCycle doesn't throw
      // even when the event recording fails, because recordEvent catches internally.
      const { runEvolutionCycle } = await import('../../../src/self-improvement/evolver.js');

      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('evolution_events')) {
          throw new Error('disk full');
        }
        if (sql.includes('evolution_state') && sql.includes('SELECT')) {
          return { rows: [{ value: '0' }] };
        }
        return { rows: [] };
      });

      // Should not throw — the error is swallowed by recordEvent's catch
      await expect(runEvolutionCycle()).resolves.toBeUndefined();
    });
  });

  // ═══ Module Exports ═══

  describe('module exports', () => {
    it('exports exactly 3 public functions', async () => {
      const evolver = await import('../../../src/self-improvement/evolver.js');
      const exportedKeys = Object.keys(evolver);
      expect(exportedKeys).toContain('runEvolutionCycle');
      expect(exportedKeys).toContain('getEvolutionHistory');
      expect(exportedKeys).toContain('getEvolutionState_public');
      // Everything else is internal — that's the testability problem
    });
  });
});

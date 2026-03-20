import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../../src/config/database.js', () => ({
  query: (...args: any[]) => mockQuery(...args),
}));
vi.mock('../../../src/utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/memory/learnings.js', () => ({
  recordLearning: vi.fn().mockResolvedValue({ id: '1' }),
}));
vi.mock('../../../src/memory/structured.js', () => ({
  upsertFact: vi.fn().mockResolvedValue({ id: '1' }),
}));
vi.mock('../../../src/agent/claude-client.js', () => ({
  callClaude: vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: 'Always double-check GPA values before submitting.' }],
  }),
  extractTextContent: (content: any[]) =>
    content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join(''),
}));

const { detectCorrection, handleCorrection } = await import(
  '../../../src/self-improvement/correction-detector.js'
);

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// FALSE POSITIVE TESTS
// These messages should NOT be detected as corrections (should return null).
// If any of these fail, they expose a false-positive weakness in the patterns.
// ============================================================================

describe('detectCorrection — false positive resistance', () => {
  it('should return null for "Actually, that\'s fantastic!" (positive sentiment with "actually")', () => {
    // "actually" alone should not trigger — the pattern requires "actually, it's/that's wrong/not/incorrect"
    const result = detectCorrection("Actually, that's fantastic!");
    expect(result).toBeNull();
  });

  it('should return null for "No problem at all" (starts with "no" but is not a correction)', () => {
    const result = detectCorrection('No problem at all');
    expect(result).toBeNull();
  });

  it('should return null for "I never knew that was possible" (has "I never" but is not a correction)', () => {
    // Pattern is: i never (said|asked|told|wanted) — "knew" is not in the list
    const result = detectCorrection('I never knew that was possible');
    expect(result).toBeNull();
  });

  it('should return null for "Wrong turn but we got there" (casual use of "wrong")', () => {
    // "wrong turn" — "turn" is not in the correction noun list (one|answer|info|...)
    const result = detectCorrection('Wrong turn but we got there');
    expect(result).toBeNull();
  });

  it('should return null for "That\'s not a bad idea actually" (double negative = positive)', () => {
    // Pattern: that's not (correct|right|true|accurate|what i|it|the)
    // "bad" is not in the list, so this should NOT match
    const result = detectCorrection("That's not a bad idea actually");
    expect(result).toBeNull();
  });

  it('should return null for "No worries, everything is fine" (starts with "no" but is reassurance)', () => {
    const result = detectCorrection('No worries, everything is fine');
    expect(result).toBeNull();
  });

  it('should return null for "The links are working great" (has "links" but positive context)', () => {
    const result = detectCorrection('The links are working great');
    expect(result).toBeNull();
  });

  it('should return null for "Hey, try again tomorrow" (has "try again" but no correction)', () => {
    // Pattern: try again, that's not — missing "that's not" part
    const result = detectCorrection('Hey, try again tomorrow');
    expect(result).toBeNull();
  });

  // BUG: This test SHOULD pass (return null) because the sentiment is positive,
  // but the pattern /actually,?\s+(it's|that's)\s+(wrong|not|incorrect|...)/ will
  // match "actually it's not" regardless of what follows. The detector has NO
  // sentiment analysis — it's purely regex-based, so it cannot distinguish
  // "actually it's not what I expected, it's even better!" (positive) from
  // "actually it's not right" (correction).
  it('BUG: false positive on "Actually it\'s not what I expected, it\'s even better!" — positive sentiment triggers correction', () => {
    const result = detectCorrection(
      "Actually it's not what I expected, it's even better!"
    );
    // This SHOULD be null (it's a compliment), but the regex will match
    // "actually it's not" and flag it as a correction.
    // Marking as expected failure to document the bug:
    expect(result).not.toBeNull(); // <-- This passes, proving the false positive
    // The correct behavior would be:
    // expect(result).toBeNull();
  });

  it('BUG: false positive on "No, that\'s wonderful!" — "no, that\'s" prefix triggers wrong pattern', () => {
    // Pattern: no,?\s+(that's?\s+)?(wrong|incorrect|not right|not what)
    // "wonderful" is not in the alternatives, so this should NOT match.
    // But "no, that's" on its own is just a prefix — let's verify it doesn't overreach.
    const result = detectCorrection("No, that's wonderful!");
    expect(result).toBeNull();
  });
});

// ============================================================================
// EDGE CASES
// ============================================================================

describe('detectCorrection — edge cases', () => {
  it('returns null for empty string', () => {
    expect(detectCorrection('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(detectCorrection('   ')).toBeNull();
  });

  it('returns null for "bad" (3 chars, below threshold of 4)', () => {
    expect(detectCorrection('bad')).toBeNull();
  });

  it('returns null for "no!" (3 chars after trim)', () => {
    expect(detectCorrection('no!')).toBeNull();
  });

  it('detects "wrong" alone (5 chars, above threshold) — but only if it matches a pattern', () => {
    // "wrong" alone does NOT match any pattern because patterns require
    // "wrong <noun>" or "wrong" in a phrase context
    const result = detectCorrection('wrong');
    expect(result).toBeNull();
  });

  it('detects "wrong answer" (matches wrong + noun pattern)', () => {
    const result = detectCorrection('wrong answer');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('correction');
  });

  // BUG: Regex \b word boundary fails when correction phrase follows a period+space
  // because \b matches between word and non-word chars, but the pattern expects
  // "that's" to start at a word boundary. In "amet. that's wrong", the \b works.
  // But the real issue is the pattern requires a specific prefix structure.
  // Actually, this test reveals that "that's wrong" alone (without "no," or "actually,")
  // does NOT match any pattern — the patterns require compound phrases.
  it('BUG: "that\'s wrong" alone does NOT match any pattern — requires prefix like "no,"', () => {
    const padding = 'Lorem ipsum dolor sit amet dolor sit amet ';
    const message = padding + "that's wrong" + padding;
    const result = detectCorrection(message);
    // "that's wrong" by itself is NOT a pattern. Patterns require:
    //   "no, that's wrong" or "that's not correct" etc.
    // This is a gap: a plain "that's wrong" should still be detected.
    expect(result).toBeNull(); // This passes, documenting the gap
  });

  it('detects "no, that\'s wrong" buried in a long message', () => {
    const padding = 'Lorem ipsum dolor sit amet dolor sit amet ';
    const message = padding + "no, that's wrong" + padding;
    const result = detectCorrection(message);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('correction');
  });

  // BUG: Unicode emoji before text can break \b word boundary matching.
  // The \b anchor doesn't work well with Unicode characters preceding ASCII words.
  it('BUG: emoji prefix breaks word boundary — "🎉 that\'s not correct" not detected', () => {
    const result = detectCorrection("🎉 that's not correct");
    // The \b before "that's" may not fire correctly after Unicode emoji + space.
    // This test documents whether the regex handles it.
    // If it fails (returns null), it exposes a Unicode word-boundary bug.
    // Let's test what actually happens:
    expect(result).not.toBeNull();
  });

  it('detects correction without emoji prefix for comparison', () => {
    const result = detectCorrection("that's not correct at all");
    expect(result).not.toBeNull();
    expect(result!.type).toBe('correction');
  });

  it('handles message with only newlines and spaces', () => {
    expect(detectCorrection('\n\n   \n')).toBeNull();
  });

  it('handles null-like inputs gracefully (type coercion)', () => {
    // TypeScript prevents this at compile time, but at runtime it could happen
    // via untyped callers. The .trim() call would throw on null/undefined.
    // This documents a potential runtime crash if called from JS without type checking.
    expect(() => detectCorrection(undefined as any)).toThrow();
  });
});

// ============================================================================
// CONFIDENCE SCORING TESTS
// ============================================================================

describe('detectCorrection — confidence scoring', () => {
  it('returns high confidence (0.9) when correction phrase is large relative to message', () => {
    // "no, that's wrong" = 17 chars, total message ~20 chars
    // ratio = 17/20 = 0.85 > 0.3 → confidence 0.9
    const result = detectCorrection("no, that's wrong!!");
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.9);
  });

  it('returns lower confidence (0.7) when correction phrase is buried in long message', () => {
    // "wrong answer" in a 200+ char message → ratio < 0.3 → confidence 0.7
    const longMessage =
      "I was looking at the report you sent me yesterday and comparing it with the original data from the spreadsheet, and I noticed that is the wrong answer because the numbers don't add up at all when you look at it carefully.";
    const result = detectCorrection(longMessage);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.7);
  });

  it('staleness signals always have confidence 0.8 regardless of message length', () => {
    const shortStaleness = "that's outdated";
    const longStaleness =
      "I was reviewing the information you provided and I believe that's outdated based on what I saw on the company website recently.";

    const resultShort = detectCorrection(shortStaleness);
    const resultLong = detectCorrection(longStaleness);

    expect(resultShort).not.toBeNull();
    expect(resultLong).not.toBeNull();
    expect(resultShort!.confidence).toBe(0.8);
    expect(resultLong!.confidence).toBe(0.8);
  });

  // BUG: Staleness confidence is hardcoded at 0.8 and does not scale with
  // match-to-message ratio like corrections do. This is inconsistent —
  // a 10-char staleness match in a 500-char message should have lower confidence.
  it('BUG: staleness confidence does not scale with message length (hardcoded 0.8)', () => {
    const longMsg =
      'I have been thinking about what you told me last week, and after checking multiple sources I realized that information is not anymore valid because the company restructured.';
    const result = detectCorrection(longMsg);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('staleness');
    // Confidence is always 0.8 for staleness, even in a long message where
    // the match is a small fraction. For corrections, this would be 0.7.
    expect(result!.confidence).toBe(0.8);
  });
});

// ============================================================================
// SPANISH EDGE CASES
// ============================================================================

describe('detectCorrection — Spanish edge cases', () => {
  it('detects "no esta mal, revisalo" (missing accent)', () => {
    // Pattern: no,?\s+(eso\s+)?está?n?\s+(mal|incorrecto|equivocado)
    // "esta" without accent should be matched by est[aá] in the regex
    const result = detectCorrection('no esta mal, revisalo');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('correction');
  });

  it('detects "no sirve el link"', () => {
    // Pattern: no\s+(sirve|funciona|jala|abre)n?
    const result = detectCorrection('no sirve el link');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('correction');
  });

  it('detects "links rotos"', () => {
    // Pattern: links?\s+rotos?
    const result = detectCorrection('links rotos');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('correction');
  });

  it('detects "link roto" (singular)', () => {
    const result = detectCorrection('link esta roto');
    expect(result).not.toBeNull();
  });

  it('detects "no jala" (Mexican slang for "doesn\'t work")', () => {
    const result = detectCorrection('no jala ese link');
    expect(result).not.toBeNull();
  });

  it('detects "mal, intenta de nuevo"', () => {
    const result = detectCorrection('mal, intenta de nuevo por favor');
    expect(result).not.toBeNull();
  });

  it('detects "ya cambio" as staleness (Spanish)', () => {
    // Pattern: ya\s+(no\s+es|cambió|no\s+está)
    const result = detectCorrection('ya cambio el precio del vuelo');
    // Note: "cambio" without accent. The regex uses cambi[oó] so it should match.
    expect(result).not.toBeNull();
    expect(result!.type).toBe('staleness');
  });
});

// ============================================================================
// handleCorrection TESTS
// ============================================================================

describe('handleCorrection', () => {
  it('queries last assistant message and previous user message from DB', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ content: 'Your GPA is 3.7' }],
      }) // last assistant
      .mockResolvedValueOnce({
        rows: [
          { content: 'what is my GPA?' },
          { content: 'some earlier question' },
        ],
      }) // last 2 user messages
      .mockResolvedValueOnce({ rows: [] }); // audit log insert

    const signal = { type: 'correction' as const, confidence: 0.9, matchedPattern: "that's wrong" };
    await handleCorrection('conv-1', "that's wrong, my GPA is 3.5", signal);

    // Should query for last assistant message
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("role = 'assistant'"),
      ['conv-1']
    );
    // Should query for last 2 user messages
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("role = 'user'"),
      ['conv-1']
    );
  });

  it('records audit log even when rule extraction returns null', async () => {
    const { callClaude } = await import('../../../src/agent/claude-client.js');
    (callClaude as any).mockResolvedValueOnce({
      content: [{ type: 'text', text: 'NONE' }],
    });

    mockQuery
      .mockResolvedValueOnce({ rows: [{ content: 'wrong response' }] })
      .mockResolvedValueOnce({ rows: [{ content: 'question' }] })
      .mockResolvedValueOnce({ rows: [] }); // audit log

    const signal = { type: 'correction' as const, confidence: 0.9, matchedPattern: 'test' };
    await handleCorrection('conv-1', 'correction message', signal);

    // Audit log should be inserted regardless of rule extraction result
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('audit_log'),
      expect.arrayContaining(['auto_correction_detected'])
    );
  });

  it('does NOT call recordLearning or upsertFact when Claude returns "NONE"', async () => {
    const { callClaude } = await import('../../../src/agent/claude-client.js');
    const { recordLearning } = await import('../../../src/memory/learnings.js');
    const { upsertFact } = await import('../../../src/memory/structured.js');

    (callClaude as any).mockResolvedValueOnce({
      content: [{ type: 'text', text: 'NONE' }],
    });

    mockQuery
      .mockResolvedValueOnce({ rows: [{ content: 'response' }] })
      .mockResolvedValueOnce({ rows: [{ content: 'question' }] })
      .mockResolvedValueOnce({ rows: [] }); // audit

    const signal = { type: 'correction' as const, confidence: 0.9, matchedPattern: 'test' };
    await handleCorrection('conv-1', 'fix this', signal);

    expect(recordLearning).not.toHaveBeenCalled();
    expect(upsertFact).not.toHaveBeenCalled();
  });

  it('returns null (not throws) when DB query fails', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB connection lost'));

    const signal = { type: 'correction' as const, confidence: 0.9, matchedPattern: 'test' };
    const result = await handleCorrection('conv-1', 'fix this', signal);
    expect(result).toBeNull();
  });

  it('handles empty conversation (no previous messages)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // no assistant messages
      .mockResolvedValueOnce({ rows: [] }) // no user messages
      .mockResolvedValueOnce({ rows: [] }); // audit log

    const signal = { type: 'correction' as const, confidence: 0.9, matchedPattern: 'test' };
    const result = await handleCorrection('conv-1', "that's wrong", signal);
    // Should not throw, should still insert audit log
    expect(result).toBeDefined();
  });
});

// ============================================================================
// PATTERN COVERAGE — ensure each pattern has at least one test
// ============================================================================

describe('detectCorrection — pattern coverage for correction patterns', () => {
  const correctionCases: [string, string][] = [
    ["no, that's wrong, fix it", 'no that\'s wrong'],
    ["actually, it's not correct at all", 'actually it\'s not'],
    ["that's not correct and needs fixing", 'that\'s not correct'],
    ["you're wrong about the date", 'you\'re wrong'],
    ['i said I wanted pizza not salad', 'i said ... not'],
    ['not that, i mean the other one', 'not that, i mean'],
    ['wrong number, it should be 42', 'wrong number'],
    ['correction: the date is March 20', 'correction:'],
    ['let me correct you on that point', 'let me correct you'],
    ['I never told you to do that', 'I never told'],
    ['you got it wrong entirely', 'you got it wrong'],
    ["nope, that's wrong answer buddy", "nope, that's wrong"],
    ["try again, that's not what I asked", "try again, that's not"],
  ];

  correctionCases.forEach(([input, description]) => {
    it(`detects: "${description}" in "${input.slice(0, 50)}"`, () => {
      const result = detectCorrection(input);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('correction');
    });
  });
});

describe('detectCorrection — pattern coverage for staleness patterns', () => {
  const stalenessCases: [string, string][] = [
    ["that's outdated information now", "that's outdated"],
    ['things changed since last week', 'changed since'],
    ['it used to be $5 but now it is $10', 'used to be ... but now'],
    ['not anymore, they closed that branch', 'not anymore'],
    ['they changed the policy recently', 'they changed'],
    ['new address is 123 Main St', 'new address'],
    ['ya no es asi, todo cambio', 'ya no es'],
    ['antes era gratis pero ahora cobran', 'antes era ... pero ahora'],
  ];

  stalenessCases.forEach(([input, description]) => {
    it(`detects staleness: "${description}" in "${input.slice(0, 50)}"`, () => {
      const result = detectCorrection(input);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('staleness');
    });
  });
});

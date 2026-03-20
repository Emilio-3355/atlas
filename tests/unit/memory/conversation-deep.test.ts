import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../../src/config/database.js', () => ({
  query: (...args: any[]) => mockQuery(...args),
}));
vi.mock('../../../src/utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/config/env.js', () => ({
  getEnv: () => ({ ANTHROPIC_API_KEY: 'test', NODE_ENV: 'test' }),
}));

const mockCallClaude = vi.fn();
vi.mock('../../../src/agent/claude-client.js', () => ({
  callClaude: (...args: any[]) => mockCallClaude(...args),
  extractTextContent: (content: any[]) =>
    content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join(''),
}));

const { shouldCompact, compactConversation, getConversationMessages } = await import(
  '../../../src/memory/conversation.js'
);

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// shouldCompact TESTS
// ============================================================================

describe('shouldCompact — boundary tests', () => {
  it('returns false for 0 messages', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ message_count: 0 }] })
      .mockResolvedValueOnce({ rows: [{ total_chars: 0 }] }); // token-based check
    expect(await shouldCompact('conv-1')).toBe(false);
  });

  it('returns false for 1 message', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ message_count: 1 }] })
      .mockResolvedValueOnce({ rows: [{ total_chars: 100 }] });
    expect(await shouldCompact('conv-1')).toBe(false);
  });

  it('returns false for 79 messages (one below threshold)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ message_count: 79 }] })
      .mockResolvedValueOnce({ rows: [{ total_chars: 1000 }] }); // small content
    expect(await shouldCompact('conv-1')).toBe(false);
  });

  it('returns true for exactly 80 messages (at threshold)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ message_count: 80 }] });
    expect(await shouldCompact('conv-1')).toBe(true);
  });

  it('returns true for 81 messages (one above threshold)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ message_count: 81 }] });
    expect(await shouldCompact('conv-1')).toBe(true);
  });

  it('returns true for 1000 messages', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ message_count: 1000 }] });
    expect(await shouldCompact('conv-1')).toBe(true);
  });

  it('returns false for nonexistent conversation (empty rows)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await shouldCompact('nonexistent')).toBe(false);
  });
});

// ============================================================================
// BUG: NO TOKEN-BASED COMPACTION
//
// The shouldCompact function ONLY checks message_count >= 80.
// It does NOT check total character count or token count.
// This means a conversation with 10 very long messages (e.g., 500K chars total)
// will NOT trigger compaction, even though it would blow past the 40% context
// window limit (320K chars for a 1M context model).
//
// The MEMORY.md says: "When context usage exceeds 40%, proactively compact."
// But the code only checks message count, not content size.
// ============================================================================

describe('FIXED: shouldCompact now checks total content size (token-based)', () => {
  it('returns true for 10 messages that total 500K characters', async () => {
    // 10 messages is below 80-message threshold, but 500K chars exceeds 320K char threshold
    mockQuery
      .mockResolvedValueOnce({ rows: [{ message_count: 10 }] })
      .mockResolvedValueOnce({ rows: [{ total_chars: 500_000 }] });
    const result = await shouldCompact('conv-huge');
    // FIXED: Now returns true because 500K > 320K char threshold
    expect(result).toBe(true);
  });

  it('returns true for 20 messages with 50K chars each (1M total)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ message_count: 20 }] })
      .mockResolvedValueOnce({ rows: [{ total_chars: 1_000_000 }] });
    const result = await shouldCompact('conv-overflow');
    // FIXED: 1M chars >> 320K threshold
    expect(result).toBe(true);
  });

  it('returns true for 35 messages (just under msg threshold) with huge content', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ message_count: 35 }] })
      .mockResolvedValueOnce({ rows: [{ total_chars: 400_000 }] });
    const result = await shouldCompact('conv-just-under');
    // FIXED: 400K > 320K char threshold triggers compaction
    expect(result).toBe(true);
  });

  it('returns false for few messages with small content', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ message_count: 15 }] })
      .mockResolvedValueOnce({ rows: [{ total_chars: 5000 }] });
    const result = await shouldCompact('conv-small');
    // 15 msgs < 80 AND 5K chars < 320K → no compaction needed
    expect(result).toBe(false);
  });
});

// ============================================================================
// getConversationMessages TESTS
// ============================================================================

describe('getConversationMessages', () => {
  it('returns messages in chronological order (reversed from DESC query)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { role: 'assistant', content: 'third', created_at: new Date('2026-03-19T03:00:00Z') },
        { role: 'user', content: 'second', created_at: new Date('2026-03-19T02:00:00Z') },
        { role: 'user', content: 'first', created_at: new Date('2026-03-19T01:00:00Z') },
      ],
    });

    const messages = await getConversationMessages('conv-1', 50);
    // The source calls .reverse() on the DESC-ordered rows
    expect(messages[0].content).toBe('first');
    expect(messages[1].content).toBe('second');
    expect(messages[2].content).toBe('third');
  });

  it('respects the limit parameter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getConversationMessages('conv-1', 25);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.any(String),
      ['conv-1', 25]
    );
  });

  it('uses default limit of 50 when not specified', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getConversationMessages('conv-1');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.any(String),
      ['conv-1', 50]
    );
  });

  it('returns empty array for empty conversation', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const messages = await getConversationMessages('conv-empty');
    expect(messages).toEqual([]);
  });
});

// ============================================================================
// compactConversation TESTS
// ============================================================================

describe('compactConversation', () => {
  it('returns empty string if conversation has <= 20 messages (KEEP_RECENT)', async () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
      created_at: new Date(Date.now() - (20 - i) * 60000),
    }));
    mockQuery.mockResolvedValueOnce({ rows: messages });

    const result = await compactConversation('conv-1');
    expect(result).toBe('');
    expect(mockCallClaude).not.toHaveBeenCalled();
  });

  it('returns empty string for exactly 20 messages (boundary)', async () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: 'user',
      content: `msg ${i}`,
      created_at: new Date(Date.now() - (20 - i) * 60000),
    }));
    mockQuery.mockResolvedValueOnce({ rows: messages });

    const result = await compactConversation('conv-1');
    expect(result).toBe('');
  });

  it('compacts when there are 21 messages (keeps 20, summarizes 1)', async () => {
    const messages = Array.from({ length: 21 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
      created_at: new Date(Date.now() - (21 - i) * 60000),
    }));

    mockQuery
      .mockResolvedValueOnce({ rows: messages }) // getConversationMessages
      .mockResolvedValueOnce({ rows: [{ summary: '' }] }) // get existing summary
      .mockResolvedValueOnce({ rows: [] }) // update summary
      .mockResolvedValueOnce({ rows: [] }); // soft-delete old messages

    mockCallClaude.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Summary of message 0' }],
    });

    const result = await compactConversation('conv-1');
    expect(result).toBe('Summary of message 0');
    expect(mockCallClaude).toHaveBeenCalledTimes(1);
  });

  it('keeps KEEP_RECENT=20 messages and summarizes the rest', async () => {
    // getConversationMessages queries DESC then reverses, so mock must return DESC order
    const messagesDesc = Array.from({ length: 40 }, (_, i) => ({
      role: (39 - i) % 2 === 0 ? 'user' : 'assistant',
      content: `message ${39 - i}`,
      created_at: new Date(Date.now() - (i + 1) * 60000),
    }));

    mockQuery
      .mockResolvedValueOnce({ rows: messagesDesc }) // getConversationMessages (DESC)
      .mockResolvedValueOnce({ rows: [{ summary: 'Previous summary' }] })
      .mockResolvedValueOnce({ rows: [] }) // update
      .mockResolvedValueOnce({ rows: [] }); // soft-delete

    mockCallClaude.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Updated summary of 20 messages' }],
    });

    const result = await compactConversation('conv-1');
    expect(result).toBe('Updated summary of 20 messages');

    // After .reverse(), messages are chronological: message 0..39
    // Old = 0..19 (summarized), Recent = 20..39 (kept)
    const claudeCallArgs = mockCallClaude.mock.calls[0][0];
    const promptContent = claudeCallArgs.messages[0].content;
    expect(promptContent).toContain('message 0');
    expect(promptContent).toContain('message 19');
    // Recent messages (20-39) should NOT be in the summary prompt
    expect(promptContent).not.toContain('[user] message 20');
  });

  it('soft-deletes old messages from DB using cutoff time', async () => {
    const messages = Array.from({ length: 25 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
      created_at: new Date(Date.now() - (25 - i) * 60000),
    }));

    mockQuery
      .mockResolvedValueOnce({ rows: messages })
      .mockResolvedValueOnce({ rows: [{ summary: '' }] })
      .mockResolvedValueOnce({ rows: [] }) // update summary
      .mockResolvedValueOnce({ rows: [] }); // soft-delete old messages

    mockCallClaude.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Summary' }],
    });

    await compactConversation('conv-1');

    // The UPDATE (soft-delete) query should use the created_at of the first "recent" message as cutoff
    const softDeleteCalls = mockQuery.mock.calls.filter((call: any[]) =>
      typeof call[0] === 'string' && call[0].includes('UPDATE messages SET compacted')
    );
    expect(softDeleteCalls.length).toBe(1);
    expect(softDeleteCalls[0][0]).toContain('conversation_id');
    expect(softDeleteCalls[0][0]).toContain('created_at');
    // The cutoff should be messages[5].created_at (first of the 20 kept messages)
    expect(softDeleteCalls[0][1][1]).toEqual(messages[5].created_at);
  });

  it('updates conversation summary in DB', async () => {
    const messages = Array.from({ length: 25 }, (_, i) => ({
      role: 'user',
      content: `msg ${i}`,
      created_at: new Date(Date.now() - (25 - i) * 60000),
    }));

    mockQuery
      .mockResolvedValueOnce({ rows: messages })
      .mockResolvedValueOnce({ rows: [{ summary: '' }] })
      .mockResolvedValueOnce({ rows: [] }) // update
      .mockResolvedValueOnce({ rows: [] }); // soft-delete

    mockCallClaude.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Fresh summary' }],
    });

    await compactConversation('conv-1');

    const updateCalls = mockQuery.mock.calls.filter((call: any[]) =>
      typeof call[0] === 'string' && call[0].includes('UPDATE conversations')
    );
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0][1][0]).toBe('Fresh summary');
    expect(updateCalls[0][1][1]).toBe('conv-1');
  });

  it('includes existing summary in the prompt when one exists', async () => {
    const messages = Array.from({ length: 25 }, (_, i) => ({
      role: 'user',
      content: `msg ${i}`,
      created_at: new Date(Date.now() - (25 - i) * 60000),
    }));

    mockQuery
      .mockResolvedValueOnce({ rows: messages })
      .mockResolvedValueOnce({ rows: [{ summary: 'This is the old summary from before.' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    mockCallClaude.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Merged summary' }],
    });

    await compactConversation('conv-1');

    const prompt = mockCallClaude.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('This is the old summary from before.');
    expect(prompt).toContain('Existing summary');
  });

  it('handles empty existing summary gracefully', async () => {
    const messages = Array.from({ length: 25 }, (_, i) => ({
      role: 'user',
      content: `msg ${i}`,
      created_at: new Date(Date.now() - (25 - i) * 60000),
    }));

    mockQuery
      .mockResolvedValueOnce({ rows: messages })
      .mockResolvedValueOnce({ rows: [{ summary: '' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    mockCallClaude.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'New summary' }],
    });

    await compactConversation('conv-1');

    const prompt = mockCallClaude.mock.calls[0][0].messages[0].content;
    // Should NOT include "Existing summary:" section when summary is empty
    expect(prompt).not.toContain('Existing summary:');
  });

  it('passes depth: "fast" and maxTokens: 1500 to callClaude', async () => {
    const messages = Array.from({ length: 25 }, (_, i) => ({
      role: 'user',
      content: `msg ${i}`,
      created_at: new Date(Date.now() - (25 - i) * 60000),
    }));

    mockQuery
      .mockResolvedValueOnce({ rows: messages })
      .mockResolvedValueOnce({ rows: [{ summary: '' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    mockCallClaude.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Summary' }],
    });

    await compactConversation('conv-1');

    const claudeArgs = mockCallClaude.mock.calls[0][0];
    expect(claudeArgs.depth).toBe('fast');
    expect(claudeArgs.maxTokens).toBe(1500);
  });
});

// ============================================================================
// BUG: compactConversation does NOT update message_count after deleting messages
//
// After soft-deleting old messages and keeping KEEP_RECENT=20, the conversation's
// message_count in the conversations table is NOT decremented. This means
// shouldCompact will keep returning true on subsequent calls, potentially
// triggering repeated compaction of the same 20 remaining messages.
// ============================================================================

describe('BUG: message_count not updated after compaction', () => {
  it('does not update message_count in conversations table after deleting messages', async () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
      created_at: new Date(Date.now() - (50 - i) * 60000),
    }));

    mockQuery
      .mockResolvedValueOnce({ rows: messages })
      .mockResolvedValueOnce({ rows: [{ summary: '' }] })
      .mockResolvedValueOnce({ rows: [] }) // UPDATE summary
      .mockResolvedValueOnce({ rows: [] }); // soft-delete old messages

    mockCallClaude.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Summary of 30 messages' }],
    });

    await compactConversation('conv-1');

    // BUG: After soft-deleting 30 messages, message_count should be updated to ~20.
    // But the code only does:
    //   1. UPDATE conversations SET summary = ... (updates summary, NOT message_count)
    //   2. UPDATE messages SET compacted = true WHERE ... (soft-deletes messages)
    // There is NO: UPDATE conversations SET message_count = 20 WHERE id = ...
    //
    // This means shouldCompact('conv-1') will STILL return true because
    // message_count is still 50 in the conversations table.
    const allQueries = mockQuery.mock.calls.map((call: any[]) => call[0]);
    const messageCountUpdate = allQueries.find(
      (q: string) => q.includes('message_count') && q.includes('UPDATE')
    );
    // This assertion documents the bug: no query updates message_count
    expect(messageCountUpdate).toBeUndefined();
  });
});

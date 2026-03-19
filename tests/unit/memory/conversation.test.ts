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
  extractTextContent: (content: any[]) => content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(''),
}));

const { shouldCompact, compactConversation } = await import('../../../src/memory/conversation.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('shouldCompact', () => {
  it('returns false when message_count < 40', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ message_count: 20 }] });
    expect(await shouldCompact('conv-1')).toBe(false);
  });

  it('returns true when message_count >= 40', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ message_count: 40 }] });
    expect(await shouldCompact('conv-1')).toBe(true);
  });

  it('returns false for non-existent conversation', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await shouldCompact('nonexistent')).toBe(false);
  });

  it('returns true for very high message count', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ message_count: 200 }] });
    expect(await shouldCompact('conv-1')).toBe(true);
  });
});

describe('compactConversation', () => {
  it('generates summary via callClaude when enough messages', async () => {
    // getConversationMessages returns 15 messages (> KEEP_RECENT=10)
    const messages = Array.from({ length: 15 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
      created_at: new Date(Date.now() - (15 - i) * 60000),
    }));
    mockQuery
      .mockResolvedValueOnce({ rows: messages }) // getConversationMessages
      .mockResolvedValueOnce({ rows: [{ summary: 'Old summary' }] }) // get summary
      .mockResolvedValueOnce({ rows: [] }) // update summary
      .mockResolvedValueOnce({ rows: [] }); // delete old messages

    mockCallClaude.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'New summary' }],
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const result = await compactConversation('conv-1');
    expect(mockCallClaude).toHaveBeenCalled();
    expect(result).toBe('New summary');
  });

  it('returns empty string when <= KEEP_RECENT messages', async () => {
    const messages = Array.from({ length: 5 }, (_, i) => ({
      role: 'user',
      content: `msg ${i}`,
      created_at: new Date(),
    }));
    mockQuery.mockResolvedValueOnce({ rows: messages });

    const result = await compactConversation('conv-1');
    expect(result).toBe('');
    expect(mockCallClaude).not.toHaveBeenCalled();
  });
});

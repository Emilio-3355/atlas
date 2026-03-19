import { describe, it, expect, vi } from 'vitest';

// We need to extract and test sanitizeMessages — it's a private function in core.ts
// We'll test it indirectly by importing the module and using a workaround
// Since it's not exported, let's create a test that validates the logic directly

describe('sanitizeMessages logic', () => {
  // Re-implement the sanitizeMessages logic here to test it in isolation
  // (The actual function is private in core.ts)
  function sanitizeMessages(messages: Array<{ role: string; content: any }>): Array<{ role: string; content: string }> {
    if (messages.length === 0) return [];

    const cleaned: Array<{ role: string; content: string }> = [];

    for (const msg of messages) {
      let content: string;
      if (typeof msg.content === 'string') {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        content = msg.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text || '')
          .join('');
        if (!content) continue;
      } else {
        continue;
      }

      if (!content.trim()) continue;

      if (content.startsWith('[{') && content.includes('"type"')) {
        try {
          const parsed = JSON.parse(content);
          if (Array.isArray(parsed)) {
            content = parsed
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text || '')
              .join('');
            if (!content.trim()) continue;
          }
        } catch {
          // Not JSON — use as-is
        }
      }

      const role = msg.role === 'user' ? 'user' : 'assistant';

      if (cleaned.length > 0 && cleaned[cleaned.length - 1].role === role) {
        const prev = cleaned[cleaned.length - 1];
        cleaned[cleaned.length - 1] = { role, content: `${prev.content}\n\n${content}` };
      } else {
        cleaned.push({ role, content });
      }
    }

    while (cleaned.length > 0 && cleaned[0].role !== 'user') {
      cleaned.shift();
    }

    while (cleaned.length > 0 && cleaned[cleaned.length - 1].role !== 'user') {
      cleaned.pop();
    }

    return cleaned;
  }

  it('returns empty array for empty input', () => {
    expect(sanitizeMessages([])).toEqual([]);
  });

  it('converts string content messages correctly', () => {
    const result = sanitizeMessages([{ role: 'user', content: 'hello' }]);
    expect(result).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('extracts text from array content blocks, skips tool_use blocks', () => {
    const result = sanitizeMessages([
      { role: 'user', content: 'search for something' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me search' },
          { type: 'tool_use', id: 't1', name: 'web_search', input: {} },
        ],
      },
      { role: 'user', content: 'thanks' },
    ]);
    // assistant message should have text extracted
    expect(result[1].content).toBe('Let me search');
    expect(result[1].role).toBe('assistant');
  });

  it('skips messages with no text content from array blocks', () => {
    const result = sanitizeMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'test', input: {} }] },
      { role: 'user', content: 'ok' },
    ]);
    // assistant message with only tool_use should be skipped
    expect(result).toHaveLength(1);
    // Both user messages merged since no assistant between them
    expect(result[0].content).toContain('hi');
    expect(result[0].content).toContain('ok');
  });

  it('skips empty/whitespace-only messages', () => {
    const result = sanitizeMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: '   ' },
      { role: 'user', content: 'world' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('hello');
    expect(result[0].content).toContain('world');
  });

  it('parses serialized JSON content blocks', () => {
    const serialized = JSON.stringify([{ type: 'text', text: 'parsed text' }]);
    const result = sanitizeMessages([{ role: 'user', content: serialized }]);
    expect(result[0].content).toBe('parsed text');
  });

  it('leaves non-JSON string starting with [{ as-is when parse fails', () => {
    const result = sanitizeMessages([{ role: 'user', content: '[{not valid json' }]);
    expect(result[0].content).toBe('[{not valid json');
  });

  it('merges consecutive same-role messages', () => {
    const result = sanitizeMessages([
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'world' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('hello');
    expect(result[0].content).toContain('world');
  });

  it('ensures first message is from user', () => {
    const result = sanitizeMessages([
      { role: 'assistant', content: 'welcome' },
      { role: 'user', content: 'hi' },
    ]);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toBe('hi');
  });

  it('ensures last message is from user', () => {
    const result = sanitizeMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    // Should remove trailing assistant
    expect(result[result.length - 1].role).toBe('user');
  });

  it('handles alternating user/assistant correctly', () => {
    const result = sanitizeMessages([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ]);
    expect(result).toHaveLength(3);
    expect(result[0].role).toBe('user');
    expect(result[1].role).toBe('assistant');
    expect(result[2].role).toBe('user');
  });

  it('handles multiple consecutive assistant messages', () => {
    const result = sanitizeMessages([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q2' },
    ]);
    expect(result).toHaveLength(3);
    expect(result[1].content).toContain('a1');
    expect(result[1].content).toContain('a2');
  });

  it('handles only assistant messages (returns empty)', () => {
    const result = sanitizeMessages([
      { role: 'assistant', content: 'a1' },
      { role: 'assistant', content: 'a2' },
    ]);
    expect(result).toEqual([]);
  });
});

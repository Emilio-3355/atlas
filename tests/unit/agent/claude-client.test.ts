import { describe, it, expect, vi } from 'vitest';

// Mock env and logger before importing claude-client
vi.mock('../../../src/config/env.js', () => ({
  getEnv: () => ({
    NODE_ENV: 'test',
    ANTHROPIC_API_KEY: 'test-key',
  }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { extractTextContent, extractToolUse, extractAllToolUse } = await import('../../../src/agent/claude-client.js');

function textBlock(text: string): any {
  return { type: 'text', text };
}

function toolUseBlock(id: string, name: string, input: any): any {
  return { type: 'tool_use', id, name, input };
}

describe('extractTextContent', () => {
  it('extracts text from TextBlock array', () => {
    const blocks = [textBlock('Hello'), textBlock(' world')];
    expect(extractTextContent(blocks)).toBe('Hello world');
  });

  it('concatenates multiple text blocks', () => {
    const blocks = [textBlock('A'), textBlock('B'), textBlock('C')];
    expect(extractTextContent(blocks)).toBe('ABC');
  });

  it('returns empty string for no text blocks', () => {
    const blocks = [toolUseBlock('1', 'test', {})];
    expect(extractTextContent(blocks)).toBe('');
  });

  it('ignores non-text blocks', () => {
    const blocks = [textBlock('Hello'), toolUseBlock('1', 'test', {}), textBlock(' world')];
    expect(extractTextContent(blocks)).toBe('Hello world');
  });

  it('returns empty string for empty array', () => {
    expect(extractTextContent([])).toBe('');
  });
});

describe('extractToolUse', () => {
  it('returns first ToolUseBlock', () => {
    const blocks = [textBlock('thinking'), toolUseBlock('t1', 'web_search', { query: 'test' })];
    const result = extractToolUse(blocks);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('web_search');
    expect(result!.id).toBe('t1');
  });

  it('returns null when no tool_use blocks', () => {
    const blocks = [textBlock('just text')];
    expect(extractToolUse(blocks)).toBeNull();
  });

  it('returns first of multiple tool_use blocks', () => {
    const blocks = [
      toolUseBlock('t1', 'first', {}),
      toolUseBlock('t2', 'second', {}),
    ];
    const result = extractToolUse(blocks);
    expect(result!.name).toBe('first');
  });
});

describe('extractAllToolUse', () => {
  it('returns all ToolUseBlock entries', () => {
    const blocks = [
      textBlock('thinking'),
      toolUseBlock('t1', 'web_search', { query: 'a' }),
      toolUseBlock('t2', 'browse', { url: 'b' }),
    ];
    const result = extractAllToolUse(blocks);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('web_search');
    expect(result[1].name).toBe('browse');
  });

  it('returns empty array for text-only content', () => {
    const blocks = [textBlock('just text'), textBlock('more text')];
    expect(extractAllToolUse(blocks)).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(extractAllToolUse([])).toHaveLength(0);
  });
});

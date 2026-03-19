import { describe, it, expect } from 'vitest';
import { formatForWhatsApp, formatApprovalButtons, formatPlayByPlay } from '../../../src/utils/format.js';

describe('formatForWhatsApp', () => {
  it('converts **bold** to *bold*', () => {
    expect(formatForWhatsApp('**hello**')).toEqual(['*hello*']);
  });

  it('converts __italic__ to _italic_', () => {
    expect(formatForWhatsApp('__hello__')).toEqual(['_hello_']);
  });

  it('converts ~~strike~~ to ~strike~', () => {
    expect(formatForWhatsApp('~~hello~~')).toEqual(['~hello~']);
  });

  it('converts inline `code` to ```code```', () => {
    expect(formatForWhatsApp('`hello`')).toEqual(['```hello```']);
  });

  it('converts # heading to *heading*', () => {
    expect(formatForWhatsApp('# Title')).toEqual(['*Title*']);
  });

  it('converts ## heading to *heading*', () => {
    expect(formatForWhatsApp('## Title')).toEqual(['*Title*']);
  });

  it('converts ### heading to *heading*', () => {
    expect(formatForWhatsApp('### Title')).toEqual(['*Title*']);
  });

  it('converts - item to • item', () => {
    expect(formatForWhatsApp('- item 1\n- item 2')).toEqual(['• item 1\n• item 2']);
  });

  it('returns single-element array for short text', () => {
    const result = formatForWhatsApp('Hello world');
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('Hello world');
  });

  it('splits text exceeding 4096 chars', () => {
    const long = 'A'.repeat(4097);
    const result = formatForWhatsApp(long);
    expect(result.length).toBeGreaterThan(1);
  });

  it('splits at double newline boundary when possible', () => {
    // Total: 2000 + 2 + 2000 + 2 + 200 = 4204 chars (over 4096)
    const text = 'A'.repeat(2000) + '\n\n' + 'B'.repeat(2000) + '\n\n' + 'C'.repeat(200);
    const result = formatForWhatsApp(text);
    expect(result.length).toBeGreaterThan(1);
    // The split should happen at the first \n\n after checking lastIndexOf
    expect(result[0].length).toBeLessThanOrEqual(4096);
  });

  it('handles empty string', () => {
    expect(formatForWhatsApp('')).toEqual(['']);
  });

  it('handles text exactly at 4096 chars', () => {
    const text = 'A'.repeat(4096);
    const result = formatForWhatsApp(text);
    expect(result).toHaveLength(1);
  });

  it('trims leading whitespace from subsequent chunks', () => {
    const text = 'A'.repeat(3000) + '\n\n' + '   ' + 'B'.repeat(3000);
    const result = formatForWhatsApp(text);
    if (result.length > 1) {
      expect(result[1]).not.toMatch(/^\s/);
    }
  });

  it('hard-splits at MAX when no good boundary', () => {
    // Single continuous line with no spaces or newlines
    const text = 'A'.repeat(8200);
    const result = formatForWhatsApp(text);
    expect(result.length).toBeGreaterThan(1);
    expect(result[0].length).toBeLessThanOrEqual(4096);
  });

  it('handles multiple formatting in same text', () => {
    const result = formatForWhatsApp('**bold** and __italic__ and ~~strike~~');
    expect(result[0]).toBe('*bold* and _italic_ and ~strike~');
  });
});

describe('formatApprovalButtons', () => {
  it('includes preview text, options, and action ID', () => {
    const result = formatApprovalButtons('Send email to boss', 'abc12345-full-uuid');
    expect(result).toContain('Send email to boss');
    expect(result).toContain('*1* — Approve');
    expect(result).toContain('*2* — Edit');
    expect(result).toContain('*3* — Cancel');
    expect(result).toContain('Action ID:');
  });

  it('truncates action ID to 8 chars', () => {
    const result = formatApprovalButtons('Test', 'abcdefghijklmnop');
    expect(result).toContain('abcdefgh');
    expect(result).not.toContain('abcdefghi');
  });
});

describe('formatPlayByPlay', () => {
  it('shows correct progress bar and step counter', () => {
    const result = formatPlayByPlay('Searching web', 2, 5);
    expect(result).toContain('▓▓░░░');
    expect(result).toContain('Step 2/5');
    expect(result).toContain('Searching web');
  });

  it('renders correctly at step 1/5', () => {
    const result = formatPlayByPlay('Start', 1, 5);
    expect(result).toContain('▓░░░░');
    expect(result).toContain('Step 1/5');
  });

  it('renders correctly at step 5/5', () => {
    const result = formatPlayByPlay('Done', 5, 5);
    expect(result).toContain('▓▓▓▓▓');
    expect(result).toContain('Step 5/5');
  });
});

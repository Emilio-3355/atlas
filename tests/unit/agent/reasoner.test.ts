import { describe, it, expect } from 'vitest';
import { determineDepth, escalateDepth } from '../../../src/agent/reasoner.js';

describe('determineDepth', () => {
  // Default
  it('returns "fast" for simple messages', () => {
    expect(determineDepth('hello')).toBe('fast');
  });

  it('returns "fast" for "what time is it"', () => {
    expect(determineDepth('what time is it')).toBe('fast');
  });

  // Deep triggers (EN)
  it('returns "deep" for "compare these options"', () => {
    expect(determineDepth('compare these options for me')).toBe('deep');
  });

  it('returns "deep" for "analyze this data"', () => {
    expect(determineDepth('analyze this data please')).toBe('deep');
  });

  it('returns "deep" for "pros and cons"', () => {
    expect(determineDepth('what are the pros and cons')).toBe('deep');
  });

  it('returns "deep" for "should i buy"', () => {
    expect(determineDepth('should i buy this stock')).toBe('deep');
  });

  it('returns "deep" for "help me decide"', () => {
    expect(determineDepth('help me decide between A and B')).toBe('deep');
  });

  // Deep triggers (ES)
  it('returns "deep" for "compara" (Spanish)', () => {
    expect(determineDepth('compara estas opciones')).toBe('deep');
  });

  it('returns "deep" for "analiza"', () => {
    expect(determineDepth('analiza estos datos')).toBe('deep');
  });

  // Expert triggers (EN)
  it('returns "expert" for "think deeply about"', () => {
    expect(determineDepth('think deeply about this problem')).toBe('expert');
  });

  it('returns "expert" for "important decision"', () => {
    expect(determineDepth('this is an important decision')).toBe('expert');
  });

  it('returns "expert" for "complex"', () => {
    expect(determineDepth('this is complex to figure out')).toBe('expert');
  });

  it('returns "expert" for "strategic"', () => {
    expect(determineDepth('what is the strategic move here')).toBe('expert');
  });

  // Expert triggers (ES)
  it('returns "expert" for "piensa bien" (Spanish)', () => {
    expect(determineDepth('piensa bien sobre esto')).toBe('expert');
  });

  it('returns "expert" for "decisión importante"', () => {
    expect(determineDepth('es una decisión importante')).toBe('expert');
  });

  // Tool-based triggers
  it('returns "expert" when propose_tool is in toolsUsed', () => {
    expect(determineDepth('create a new tool', 0, ['propose_tool'])).toBe('expert');
  });

  it('returns "deep" when send_email is in toolsUsed', () => {
    expect(determineDepth('ok', 0, ['send_email'])).toBe('deep');
  });

  it('returns "deep" when calendar_create is in toolsUsed', () => {
    expect(determineDepth('ok', 0, ['calendar_create'])).toBe('deep');
  });

  // Chain length trigger
  it('returns "deep" when toolChainLength >= 5', () => {
    expect(determineDepth('continue', 5)).toBe('deep');
  });

  it('returns "fast" when toolChainLength < 5', () => {
    expect(determineDepth('continue', 4)).toBe('fast');
  });

  // Retry escalation
  it('returns "deep" when isRetry is true', () => {
    expect(determineDepth('try again', 0, [], true)).toBe('deep');
  });
});

describe('escalateDepth', () => {
  it('returns "deep" from "fast"', () => {
    expect(escalateDepth('fast')).toBe('deep');
  });

  it('returns "expert" from "deep"', () => {
    expect(escalateDepth('deep')).toBe('expert');
  });

  it('returns "expert" from "expert" (ceiling)', () => {
    expect(escalateDepth('expert')).toBe('expert');
  });
});

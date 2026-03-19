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

const { detectCorrection } = await import('../../../src/self-improvement/correction-detector.js');

describe('detectCorrection', () => {
  it('returns null for short messages (< 8 chars)', () => {
    expect(detectCorrection('no')).toBeNull();
    expect(detectCorrection('yes')).toBeNull();
    expect(detectCorrection('hi')).toBeNull();
  });

  it('returns null for clean messages', () => {
    expect(detectCorrection('what is the weather today')).toBeNull();
    expect(detectCorrection('send an email to john about the meeting')).toBeNull();
  });

  it('detects "no that\'s wrong"', () => {
    const result = detectCorrection("no, that's wrong, it should be different");
    expect(result).not.toBeNull();
    expect(result!.type).toBe('correction');
  });

  it('detects "actually it\'s"', () => {
    const result = detectCorrection("actually, it's not 3.7 it's 3.5");
    expect(result).not.toBeNull();
  });

  it('detects "that\'s not correct"', () => {
    const result = detectCorrection("that's not correct, the answer is different");
    expect(result).not.toBeNull();
    expect(result!.type).toBe('correction');
  });

  it('detects "you\'re wrong"', () => {
    const result = detectCorrection("you're wrong about that, let me correct you");
    expect(result).not.toBeNull();
  });

  it('detects "wrong answer"', () => {
    const result = detectCorrection('wrong answer, try again please');
    expect(result).not.toBeNull();
  });

  it('detects "I never said"', () => {
    const result = detectCorrection('I never said I wanted that, please fix it');
    expect(result).not.toBeNull();
  });

  it('detects Spanish "te equivocas"', () => {
    const result = detectCorrection('te equivocas, eso no es lo que pedí');
    expect(result).not.toBeNull();
  });

  it('detects Spanish "eso no es correcto"', () => {
    const result = detectCorrection('eso no es correcto, revísalo de nuevo');
    expect(result).not.toBeNull();
  });

  it('detects "hay un error"', () => {
    const result = detectCorrection('hay un error en lo que me mandaste');
    expect(result).not.toBeNull();
  });

  it('detects "that\'s outdated" as staleness', () => {
    const result = detectCorrection("that's outdated information, please update it");
    expect(result).not.toBeNull();
    expect(result!.type).toBe('staleness');
  });

  it('detects "not anymore" as staleness', () => {
    const result = detectCorrection("not anymore, things have changed since then");
    expect(result).not.toBeNull();
  });

  it('detects "ya no es" as staleness (ES)', () => {
    const result = detectCorrection('ya no es así, las cosas cambiaron');
    expect(result).not.toBeNull();
  });
});

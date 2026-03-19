import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/config/env.js', () => ({
  getEnv: () => ({
    NODE_ENV: 'test',
    OPENAI_API_KEY: 'test-key',
    TELEGRAM_BOT_TOKEN: '',
  }),
}));
vi.mock('../../../src/utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { detectVideoUrl, containsVideoUrl } = await import('../../../src/services/video.js');

describe('detectVideoUrl', () => {
  // YouTube
  it('detects standard YouTube URL', () => {
    const result = detectVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(result).not.toBeNull();
    expect(result!.platform).toBe('youtube');
    expect(result!.videoId).toBe('dQw4w9WgXcQ');
  });

  it('detects YouTube short URL (youtu.be)', () => {
    const result = detectVideoUrl('https://youtu.be/dQw4w9WgXcQ');
    expect(result).not.toBeNull();
    expect(result!.platform).toBe('youtube');
    expect(result!.videoId).toBe('dQw4w9WgXcQ');
  });

  it('detects YouTube Shorts URL', () => {
    const result = detectVideoUrl('https://youtube.com/shorts/abc12345678');
    expect(result).not.toBeNull();
    expect(result!.platform).toBe('youtube');
    expect(result!.videoId).toBe('abc12345678');
  });

  it('detects YouTube live URL', () => {
    const result = detectVideoUrl('https://www.youtube.com/live/abc12345678');
    expect(result).not.toBeNull();
    expect(result!.platform).toBe('youtube');
  });

  it('detects YouTube URL without www', () => {
    const result = detectVideoUrl('https://youtube.com/watch?v=dQw4w9WgXcQ');
    expect(result).not.toBeNull();
  });

  it('detects YouTube URL with mobile prefix', () => {
    const result = detectVideoUrl('https://m.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(result).not.toBeNull();
  });

  it('detects YouTube URL embedded in text', () => {
    const result = detectVideoUrl('Check this out: https://www.youtube.com/watch?v=dQw4w9WgXcQ amazing');
    expect(result).not.toBeNull();
    expect(result!.videoId).toBe('dQw4w9WgXcQ');
  });

  it('detects YouTube URL without https', () => {
    const result = detectVideoUrl('youtube.com/watch?v=dQw4w9WgXcQ');
    expect(result).not.toBeNull();
  });

  // Instagram
  it('detects Instagram Reel URL', () => {
    const result = detectVideoUrl('https://www.instagram.com/reel/ABC123xyz/');
    expect(result).not.toBeNull();
    expect(result!.platform).toBe('instagram');
    expect(result!.videoId).toBe('ABC123xyz');
  });

  it('detects Instagram post URL', () => {
    const result = detectVideoUrl('https://instagram.com/p/ABC123xyz/');
    expect(result).not.toBeNull();
    expect(result!.platform).toBe('instagram');
  });

  it('detects Instagram TV URL', () => {
    const result = detectVideoUrl('https://www.instagram.com/tv/ABC123xyz/');
    expect(result).not.toBeNull();
    expect(result!.platform).toBe('instagram');
  });

  it('detects Instagram URL without www', () => {
    const result = detectVideoUrl('https://instagram.com/reel/ABC123xyz/');
    expect(result).not.toBeNull();
  });

  it('detects Instagram URL embedded in text', () => {
    const result = detectVideoUrl('Mira esto https://www.instagram.com/reel/XYZ789abc/ que cool');
    expect(result).not.toBeNull();
    expect(result!.platform).toBe('instagram');
  });

  // Non-video URLs
  it('returns null for regular URL', () => {
    expect(detectVideoUrl('https://www.google.com')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(detectVideoUrl('')).toBeNull();
  });

  it('returns null for plain text', () => {
    expect(detectVideoUrl('hello world')).toBeNull();
  });

  it('returns null for non-video YouTube URL', () => {
    expect(detectVideoUrl('https://www.youtube.com/channel/UCxyz')).toBeNull();
  });
});

describe('containsVideoUrl', () => {
  it('returns true for YouTube URL', () => {
    expect(containsVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
  });

  it('returns true for Instagram reel', () => {
    expect(containsVideoUrl('https://www.instagram.com/reel/ABC123/')).toBe(true);
  });

  it('returns false for plain text', () => {
    expect(containsVideoUrl('hello world')).toBe(false);
  });

  it('returns true for text containing YouTube URL', () => {
    expect(containsVideoUrl('check this video https://youtu.be/dQw4w9WgXcQ')).toBe(true);
  });

  it('returns false for non-video URL', () => {
    expect(containsVideoUrl('https://www.google.com/search')).toBe(false);
  });
});

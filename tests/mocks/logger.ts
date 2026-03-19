import { vi } from 'vitest';

export function setupLoggerMock() {
  vi.mock('../../src/utils/logger.js', () => ({
    default: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  }));
}

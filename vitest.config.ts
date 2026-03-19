import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/config/migrate.ts'],
    },
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});

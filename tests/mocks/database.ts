import { vi } from 'vitest';

export const mockQuery = vi.fn();
export const mockGetClient = vi.fn();

export function setupDatabaseMock() {
  vi.mock('../../src/config/database.js', () => ({
    query: mockQuery,
    getClient: mockGetClient,
    getPool: vi.fn(),
    closePool: vi.fn(),
  }));
}

export function mockQueryResult(rows: any[] = [], rowCount: number | null = null) {
  return { rows, rowCount: rowCount ?? rows.length, command: 'SELECT', oid: 0, fields: [] };
}

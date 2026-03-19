import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

// Mock logger
vi.mock('../../../src/utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock fs — we control every filesystem call
const mockFs = {
  existsSync: vi.fn(),
  statSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
};
vi.mock('fs', () => ({ default: mockFs, ...mockFs }));

const { filesystemTool } = await import('../../../src/tools/built-in/filesystem.js');

const ctx = { conversationId: 'test-conv', userPhone: '+1234', language: 'en', channel: 'whatsapp' as const };

describe('filesystem tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- isPathAllowed (tested indirectly through execute) ---

  describe('path access control', () => {
    it('allows /app paths', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.statSync.mockReturnValue({ size: 100 });
      mockFs.readFileSync.mockReturnValue('content');
      const result = await filesystemTool.execute({ action: 'read', path: '/app/test.txt' }, ctx);
      expect(result.success).toBe(true);
    });

    it('allows /tmp/atlas-voice paths', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.statSync.mockReturnValue({ size: 50 });
      mockFs.readFileSync.mockReturnValue('voice data');
      const result = await filesystemTool.execute({ action: 'read', path: '/tmp/atlas-voice/audio.ogg' }, ctx);
      expect(result.success).toBe(true);
    });

    it('allows /tmp/atlas-files paths', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.statSync.mockReturnValue({ size: 50 });
      mockFs.readFileSync.mockReturnValue('file data');
      const result = await filesystemTool.execute({ action: 'read', path: '/tmp/atlas-files/doc.pdf' }, ctx);
      expect(result.success).toBe(true);
    });

    it('blocks /etc paths', async () => {
      const result = await filesystemTool.execute({ action: 'read', path: '/etc/passwd' }, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Access denied');
    });

    it('blocks /home paths', async () => {
      const result = await filesystemTool.execute({ action: 'read', path: '/home/user/secret' }, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Access denied');
    });

    it('blocks /var paths', async () => {
      const result = await filesystemTool.execute({ action: 'read', path: '/var/log/syslog' }, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Access denied');
    });

    it('blocks root path /', async () => {
      const result = await filesystemTool.execute({ action: 'read', path: '/' }, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Access denied');
    });
  });

  // --- sanitizePath: removes .. traversal ---

  describe('path traversal prevention', () => {
    it('removes .. from paths (traversal blocked by allowed dirs)', async () => {
      // /app/../etc/passwd -> after sanitize, .. is removed -> /app/etc/passwd (still under /app)
      // But the real danger is /tmp/atlas-files/../../etc/passwd
      // sanitizePath normalizes then removes .., so it becomes safe
      const result = await filesystemTool.execute({ action: 'read', path: '/tmp/atlas-files/../../etc/passwd' }, ctx);
      // After normalize: /etc/passwd, after replace ..: /etc/passwd (no .. left after normalize)
      // This should be blocked since /etc is not allowed
      expect(result.success).toBe(false);
      expect(result.error).toContain('Access denied');
    });

    it('handles nested traversal attempts', async () => {
      const result = await filesystemTool.execute({ action: 'read', path: '/app/../../root/.ssh/id_rsa' }, ctx);
      // path.normalize resolves to /root/.ssh/id_rsa, not under allowed dirs
      expect(result.success).toBe(false);
      expect(result.error).toContain('Access denied');
    });
  });

  // --- read action ---

  describe('read action', () => {
    it('reads a file successfully', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.statSync.mockReturnValue({ size: 256 });
      mockFs.readFileSync.mockReturnValue('hello world');
      const result = await filesystemTool.execute({ action: 'read', path: '/app/data.txt' }, ctx);
      expect(result.success).toBe(true);
      expect(result.data.content).toBe('hello world');
      expect(result.data.size).toBe(256);
      expect(result.data.path).toBe('/app/data.txt');
    });

    it('rejects files over 1MB', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.statSync.mockReturnValue({ size: 2 * 1024 * 1024 }); // 2MB
      const result = await filesystemTool.execute({ action: 'read', path: '/app/big.bin' }, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('too large');
    });

    it('allows files exactly at 1MB', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.statSync.mockReturnValue({ size: 1024 * 1024 }); // exactly 1MB
      mockFs.readFileSync.mockReturnValue('data');
      const result = await filesystemTool.execute({ action: 'read', path: '/app/exact.bin' }, ctx);
      // 1024*1024 is NOT > 1024*1024, so it should succeed
      expect(result.success).toBe(true);
    });

    it('fails for non-existent file', async () => {
      mockFs.existsSync.mockReturnValue(false);
      const result = await filesystemTool.execute({ action: 'read', path: '/app/missing.txt' }, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('File not found');
    });
  });

  // --- write action ---

  describe('write action', () => {
    it('writes content to a file', async () => {
      mockFs.existsSync.mockReturnValue(true); // dir exists
      const result = await filesystemTool.execute({ action: 'write', path: '/app/output.txt', content: 'test data' }, ctx);
      expect(result.success).toBe(true);
      expect(result.data.message).toContain('9 bytes');
      expect(mockFs.writeFileSync).toHaveBeenCalledWith('/app/output.txt', 'test data', 'utf-8');
    });

    it('creates directory if it does not exist', async () => {
      mockFs.existsSync.mockReturnValue(false); // dir does not exist
      const result = await filesystemTool.execute({ action: 'write', path: '/app/new/dir/file.txt', content: 'hello' }, ctx);
      expect(result.success).toBe(true);
      expect(mockFs.mkdirSync).toHaveBeenCalledWith('/app/new/dir', { recursive: true });
    });

    it('requires content parameter', async () => {
      const result = await filesystemTool.execute({ action: 'write', path: '/app/file.txt' }, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Content is required');
    });

    it('rejects writing to disallowed paths', async () => {
      const result = await filesystemTool.execute({ action: 'write', path: '/etc/crontab', content: 'bad' }, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Access denied');
    });
  });

  // --- list action ---

  describe('list action', () => {
    it('lists directory entries', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue([
        { name: 'file.txt', isDirectory: () => false, isFile: () => true },
        { name: 'subdir', isDirectory: () => true, isFile: () => false },
      ]);
      mockFs.statSync.mockReturnValue({ size: 100 });

      const result = await filesystemTool.execute({ action: 'list', path: '/app' }, ctx);
      expect(result.success).toBe(true);
      expect(result.data.count).toBe(2);
      expect(result.data.items[0]).toEqual({ name: 'file.txt', type: 'file', size: 100 });
      expect(result.data.items[1]).toEqual({ name: 'subdir', type: 'directory', size: undefined });
    });

    it('fails for non-existent directory', async () => {
      mockFs.existsSync.mockReturnValue(false);
      const result = await filesystemTool.execute({ action: 'list', path: '/app/nope' }, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Directory not found');
    });
  });

  // --- delete action ---

  describe('delete action', () => {
    it('deletes a file', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.statSync.mockReturnValue({ isDirectory: () => false });
      const result = await filesystemTool.execute({ action: 'delete', path: '/app/old.log' }, ctx);
      expect(result.success).toBe(true);
      expect(result.data.message).toContain('Deleted');
      expect(mockFs.unlinkSync).toHaveBeenCalledWith('/app/old.log');
    });

    it('refuses to delete directories', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.statSync.mockReturnValue({ isDirectory: () => true });
      const result = await filesystemTool.execute({ action: 'delete', path: '/app/somedir' }, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Cannot delete directories');
    });

    it('fails for non-existent path', async () => {
      mockFs.existsSync.mockReturnValue(false);
      const result = await filesystemTool.execute({ action: 'delete', path: '/app/ghost.txt' }, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Path not found');
    });

    it('rejects deleting from disallowed paths', async () => {
      const result = await filesystemTool.execute({ action: 'delete', path: '/var/log/important.log' }, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Access denied');
    });
  });

  // --- unknown action ---

  describe('unknown action', () => {
    it('returns error for unknown action', async () => {
      const result = await filesystemTool.execute({ action: 'rename', path: '/app/test' }, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown action');
      expect(result.error).toContain('rename');
    });
  });

  // --- tool metadata ---

  describe('tool metadata', () => {
    it('has requiresApproval set to true', () => {
      expect(filesystemTool.requiresApproval).toBe(true);
    });

    it('has correct name', () => {
      expect(filesystemTool.name).toBe('filesystem');
    });

    it('is built-in and enabled', () => {
      expect(filesystemTool.builtIn).toBe(true);
      expect(filesystemTool.enabled).toBe(true);
    });
  });
});

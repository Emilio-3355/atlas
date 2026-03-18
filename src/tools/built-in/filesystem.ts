import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import fs from 'fs';
import path from 'path';
import logger from '../../utils/logger.js';

// Jailed directories — only allow access here
const ALLOWED_DIRS = [
  '/app',           // Railway container root
  '/tmp/atlas-voice', // Voice temp files
  '/tmp/atlas-files', // General temp files
];

function isPathAllowed(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  return ALLOWED_DIRS.some((dir) => resolved.startsWith(dir));
}

function sanitizePath(inputPath: string): string {
  // Prevent path traversal
  const normalized = path.normalize(inputPath).replace(/\.\./g, '');
  return normalized;
}

export const filesystemTool: ToolDefinition = {
  name: 'filesystem',
  description: 'Read, write, list, and search files on the Atlas server. Jailed to /app/ (project) and /tmp/atlas-*/ directories. Use for reading logs, configs, managing uploaded/downloaded files.',
  category: 'action',
  requiresApproval: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['read', 'write', 'list', 'search', 'info', 'delete'],
        description: 'Operation to perform',
      },
      path: { type: 'string', description: 'File or directory path' },
      content: { type: 'string', description: 'Content to write (for write action)' },
      pattern: { type: 'string', description: 'Glob pattern (for search action, e.g., "**/*.ts")' },
      encoding: { type: 'string', description: 'File encoding (default: utf-8)' },
    },
    required: ['action', 'path'],
  },
  enabled: true,
  builtIn: true,

  async execute(
    input: { action: string; path: string; content?: string; pattern?: string; encoding?: string },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const sanitized = sanitizePath(input.path);

    if (!isPathAllowed(sanitized)) {
      return { success: false, error: `Access denied: path "${sanitized}" is outside allowed directories (${ALLOWED_DIRS.join(', ')})` };
    }

    try {
      switch (input.action) {
        case 'read': {
          if (!fs.existsSync(sanitized)) {
            return { success: false, error: `File not found: ${sanitized}` };
          }
          const stat = fs.statSync(sanitized);
          if (stat.size > 1024 * 1024) { // 1MB limit
            return { success: false, error: `File too large (${Math.round(stat.size / 1024)}KB). Max 1MB.` };
          }
          const content = fs.readFileSync(sanitized, (input.encoding || 'utf-8') as BufferEncoding);
          return { success: true, data: { content, size: stat.size, path: sanitized } };
        }

        case 'write': {
          if (!input.content) {
            return { success: false, error: 'Content is required for write action' };
          }
          const dir = path.dirname(sanitized);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(sanitized, input.content, (input.encoding || 'utf-8') as BufferEncoding);
          return { success: true, data: { message: `Written ${input.content.length} bytes to ${sanitized}`, path: sanitized } };
        }

        case 'list': {
          if (!fs.existsSync(sanitized)) {
            return { success: false, error: `Directory not found: ${sanitized}` };
          }
          const entries = fs.readdirSync(sanitized, { withFileTypes: true });
          const items = entries.map((e) => ({
            name: e.name,
            type: e.isDirectory() ? 'directory' : 'file',
            size: e.isFile() ? fs.statSync(path.join(sanitized, e.name)).size : undefined,
          }));
          return { success: true, data: { path: sanitized, count: items.length, items } };
        }

        case 'search': {
          const searchPattern = input.pattern || '**/*';
          const results: string[] = [];
          // Simple recursive file search
          function walkDir(dir: string, pattern: RegExp, acc: string[]) {
            try {
              const entries = fs.readdirSync(dir, { withFileTypes: true });
              for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                  walkDir(fullPath, pattern, acc);
                } else if (entry.isFile() && pattern.test(entry.name)) {
                  acc.push(fullPath);
                }
              }
            } catch {}
          }
          // Convert glob-like pattern to regex
          const regexPattern = new RegExp(
            searchPattern
              .replace(/\./g, '\\.')
              .replace(/\*\*/g, '.*')
              .replace(/\*/g, '[^/]*')
              .replace(/\?/g, '.')
          );
          walkDir(sanitized, regexPattern, results);
          return { success: true, data: { pattern: searchPattern, count: results.length, files: results.slice(0, 100) } };
        }

        case 'info': {
          if (!fs.existsSync(sanitized)) {
            return { success: false, error: `Path not found: ${sanitized}` };
          }
          const stat = fs.statSync(sanitized);
          return {
            success: true,
            data: {
              path: sanitized,
              type: stat.isDirectory() ? 'directory' : 'file',
              size: stat.size,
              sizeHuman: stat.size > 1024 * 1024 ? `${(stat.size / 1024 / 1024).toFixed(1)}MB` : `${(stat.size / 1024).toFixed(1)}KB`,
              modified: stat.mtime.toISOString(),
              created: stat.birthtime.toISOString(),
            },
          };
        }

        case 'delete': {
          if (!fs.existsSync(sanitized)) {
            return { success: false, error: `Path not found: ${sanitized}` };
          }
          // Extra safety: never delete directories, only files
          const stat = fs.statSync(sanitized);
          if (stat.isDirectory()) {
            return { success: false, error: 'Cannot delete directories. Only files.' };
          }
          fs.unlinkSync(sanitized);
          return { success: true, data: { message: `Deleted: ${sanitized}` } };
        }

        default:
          return { success: false, error: `Unknown action: ${input.action}. Use: read, write, list, search, info, delete` };
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

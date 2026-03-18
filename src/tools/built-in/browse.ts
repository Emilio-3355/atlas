import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { loadPage } from '../../services/browser.js';
import { tagContent, detectInjection } from '../../security/content-trust.js';
import logger from '../../utils/logger.js';

export const browseTool: ToolDefinition = {
  name: 'browse',
  description: 'Load a URL with a headless browser and extract readable text content. Use for reading web pages, articles, restaurant details, etc. Content is marked as UNTRUSTED.',
  category: 'informational',
  requiresApproval: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      url: { type: 'string', description: 'URL to load' },
      waitMs: { type: 'number', description: 'Time to wait for page load in ms (default 3000)' },
    },
    required: ['url'],
  },
  enabled: true,
  builtIn: true,

  async execute(input: { url: string; waitMs?: number }, ctx: ToolContext): Promise<ToolResult> {
    try {
      const { page, content } = await loadPage(input.url, input.waitMs);
      await page.close();

      // Check for injection attempts
      const injection = detectInjection(content);
      if (injection.detected) {
        logger.warn('Injection detected in web content', { url: input.url, patterns: injection.patterns });
        return {
          success: true,
          data: {
            content: tagContent(content, 'hostile', input.url),
            warning: `⚠️ Potential prompt injection detected in page content. Patterns: ${injection.patterns.join(', ')}`,
            url: input.url,
          },
        };
      }

      return {
        success: true,
        data: {
          content: tagContent(content, 'untrusted', input.url),
          url: input.url,
          length: content.length,
        },
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('Browse error', { error: errMsg, url: input.url });
      return { success: false, error: errMsg };
    }
  },
};

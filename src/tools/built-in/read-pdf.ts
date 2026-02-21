import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { loadPage } from '../../services/browser.js';
import { tagContent, detectInjection } from '../../security/content-trust.js';
import logger from '../../utils/logger.js';

export const readPdfTool: ToolDefinition = {
  name: 'read_pdf',
  description: 'Extract text from a PDF URL. Use for reading documents, reports, or attachments. Content is tagged as UNTRUSTED.',
  category: 'informational',
  requiresApproval: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      url: { type: 'string', description: 'URL of the PDF to read' },
    },
    required: ['url'],
  },
  enabled: true,
  builtIn: true,

  async execute(input: { url: string }, ctx: ToolContext): Promise<ToolResult> {
    try {
      // Use browser to load PDF viewer and extract text
      const { page, content } = await loadPage(input.url, 5000);
      await page.close();

      if (!content || content.length < 50) {
        // Fallback: try fetching raw PDF and extracting what we can
        const response = await fetch(input.url);
        const buffer = await response.arrayBuffer();
        const text = Buffer.from(buffer).toString('utf-8').replace(/[^\x20-\x7E\n]/g, ' ').trim();

        return {
          success: true,
          data: {
            content: tagContent(text.slice(0, 10000), 'untrusted', input.url),
            url: input.url,
            method: 'raw',
          },
        };
      }

      const injection = detectInjection(content);

      return {
        success: true,
        data: {
          content: tagContent(content, injection.detected ? 'hostile' : 'untrusted', input.url),
          url: input.url,
          length: content.length,
          warning: injection.detected ? `⚠️ Injection attempt detected in PDF` : undefined,
        },
      };
    } catch (err) {
      logger.error('PDF read error', { error: err, url: input.url });
      return { success: false, error: err instanceof Error ? err.message : 'PDF read failed' };
    }
  },
};

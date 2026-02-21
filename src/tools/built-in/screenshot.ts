import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { takeScreenshot } from '../../services/browser.js';
import logger from '../../utils/logger.js';

export const screenshotTool: ToolDefinition = {
  name: 'screenshot',
  description: 'Take a screenshot of a web page and send it to JP via WhatsApp. Use for showing restaurant pages, search results, booking forms, etc.',
  category: 'informational',
  requiresApproval: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      url: { type: 'string', description: 'URL to screenshot' },
      caption: { type: 'string', description: 'Optional caption for the image' },
    },
    required: ['url'],
  },
  enabled: true,
  builtIn: true,

  async execute(input: { url: string; caption?: string }, ctx: ToolContext): Promise<ToolResult> {
    try {
      const buffer = await takeScreenshot(input.url);

      // For WhatsApp, we need a publicly accessible URL
      // In production, upload to a temporary storage and return URL
      // For now, base64 encode
      const base64 = buffer.toString('base64');

      return {
        success: true,
        data: {
          screenshot: `data:image/png;base64,${base64}`,
          url: input.url,
          caption: input.caption,
          size: buffer.length,
        },
      };
    } catch (err) {
      logger.error('Screenshot error', { error: err, url: input.url });
      return { success: false, error: err instanceof Error ? err.message : 'Screenshot failed' };
    }
  },
};

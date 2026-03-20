import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { takeScreenshot } from '../../services/browser.js';
import { sendImage } from '../../agent/responder.js';
import { getEnv } from '../../config/env.js';
import logger from '../../utils/logger.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const screenshotTool: ToolDefinition = {
  name: 'screenshot',
  description: 'Take a screenshot of a web page and send it to JP. Use for showing restaurant pages, search results, booking forms, maps, or any visual content.',
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

      // Save to temp file and serve via public URL
      const filename = `screenshot_${crypto.randomBytes(8).toString('hex')}.png`;
      const tempDir = '/tmp/atlas-screenshots';
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
      const filePath = path.join(tempDir, filename);
      fs.writeFileSync(filePath, buffer);

      const baseUrl = getEnv().BASE_URL;
      const mediaUrl = `${baseUrl}/media/img/${filename}`;

      // Send the screenshot directly to JP
      await sendImage(ctx.userPhone, mediaUrl, input.caption || input.url, ctx.channel);

      // Clean up after 10 minutes
      setTimeout(() => {
        try { fs.unlinkSync(filePath); } catch {}
      }, 10 * 60 * 1000);

      return {
        success: true,
        data: {
          message: 'Screenshot sent to JP',
          url: input.url,
          caption: input.caption,
          sizeKb: Math.round(buffer.length / 1024),
        },
      };
    } catch (err) {
      logger.error('Screenshot error', { error: err, url: input.url });
      return { success: false, error: err instanceof Error ? err.message : 'Screenshot failed' };
    }
  },
};

import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { createPage } from '../../services/browser.js';
import logger from '../../utils/logger.js';

export const fillFormTool: ToolDefinition = {
  name: 'fill_form',
  description: 'Fill and optionally submit a web form using Playwright. Takes a URL and field values. Screenshots each step for JP to verify. Requires approval before submission.',
  category: 'action',
  requiresApproval: true,
  inputSchema: {
    type: 'object' as const,
    properties: {
      url: { type: 'string', description: 'URL of the page with the form' },
      fields: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector for the field' },
            value: { type: 'string', description: 'Value to fill' },
            type: { type: 'string', enum: ['text', 'select', 'checkbox', 'radio', 'click'], description: 'Field type' },
          },
          required: ['selector', 'value', 'type'],
        },
        description: 'Form fields to fill',
      },
      submitSelector: { type: 'string', description: 'CSS selector for submit button (optional — will not submit without approval)' },
    },
    required: ['url', 'fields'],
  },
  enabled: true,
  builtIn: true,

  formatApproval(input: { url: string; fields: any[]; submitSelector?: string }) {
    const fieldsSummary = input.fields.map((f) => `  • ${f.selector}: "${f.value}"`).join('\n');
    return `I'd like to fill a form:\n\n*URL:* ${input.url}\n*Fields:*\n${fieldsSummary}\n${input.submitSelector ? '*Will submit after filling*' : '*Fill only — no submit*'}\n\nReply: *1* — Fill  *2* — Edit  *3* — Cancel`;
  },

  async execute(
    input: { url: string; fields: Array<{ selector: string; value: string; type: string }>; submitSelector?: string },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const page = await createPage();

    try {
      await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2000);

      for (const field of input.fields) {
        switch (field.type) {
          case 'text':
            await page.fill(field.selector, field.value);
            break;
          case 'select':
            await page.selectOption(field.selector, field.value);
            break;
          case 'checkbox':
            if (field.value === 'true') await page.check(field.selector);
            else await page.uncheck(field.selector);
            break;
          case 'radio':
            await page.click(field.selector);
            break;
          case 'click':
            await page.click(field.selector);
            break;
        }
        await page.waitForTimeout(500);
      }

      // Screenshot the filled form
      const screenshot = await page.screenshot({ type: 'png' });

      if (input.submitSelector) {
        await page.click(input.submitSelector);
        await page.waitForTimeout(3000);
        const afterScreenshot = await page.screenshot({ type: 'png' });

        return {
          success: true,
          data: {
            submitted: true,
            filledScreenshot: `data:image/png;base64,${screenshot.toString('base64')}`,
            afterScreenshot: `data:image/png;base64,${afterScreenshot.toString('base64')}`,
          },
        };
      }

      return {
        success: true,
        data: {
          submitted: false,
          filledScreenshot: `data:image/png;base64,${screenshot.toString('base64')}`,
        },
      };
    } catch (err) {
      logger.error('Fill form error', { error: err, url: input.url });
      return { success: false, error: err instanceof Error ? err.message : 'Form fill failed' };
    } finally {
      await page.close();
    }
  },
};

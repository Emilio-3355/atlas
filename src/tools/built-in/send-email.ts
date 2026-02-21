import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { sendEmail } from '../../services/gmail.js';
import logger from '../../utils/logger.js';

export const sendEmailTool: ToolDefinition = {
  name: 'send_email',
  description: 'Compose and send an email via JP\'s Gmail. Always shows a full preview for JP to approve before sending.',
  category: 'action',
  requiresApproval: true,
  inputSchema: {
    type: 'object' as const,
    properties: {
      to: { type: 'string', description: 'Recipient email address' },
      subject: { type: 'string', description: 'Email subject line' },
      body: { type: 'string', description: 'Email body text' },
    },
    required: ['to', 'subject', 'body'],
  },
  enabled: true,
  builtIn: true,

  formatApproval(input: { to: string; subject: string; body: string }) {
    const bodyPreview = input.body.length > 300 ? input.body.slice(0, 300) + '...' : input.body;
    return `I'd like to send an email:\n\n*To:* ${input.to}\n*Subject:* ${input.subject}\n*Body:*\n${bodyPreview}\n\nReply: *1* — Send  *2* — Edit  *3* — Cancel`;
  },

  async execute(input: { to: string; subject: string; body: string }, ctx: ToolContext): Promise<ToolResult> {
    try {
      const messageId = await sendEmail(input.to, input.subject, input.body);

      return {
        success: true,
        data: { messageId, message: `Email sent to ${input.to}: "${input.subject}"` },
      };
    } catch (err) {
      logger.error('Send email error', { error: err, to: input.to });
      return { success: false, error: err instanceof Error ? err.message : 'Failed to send email' };
    }
  },
};

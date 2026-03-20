import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { getEnv } from '../../config/env.js';
import { initiateOutboundCall } from '../../services/voice-call.js';
import logger from '../../utils/logger.js';

export const makeCallTool: ToolDefinition = {
  name: 'make_call',
  description:
    'Make an outbound phone call to someone on JP\'s behalf. Atlas will call the number, greet them with the specified purpose, and have a conversation. After the call ends, Atlas reports back what was discussed. Requires JP\'s approval before dialing.',
  category: 'action',
  requiresApproval: true,
  inputSchema: {
    type: 'object' as const,
    properties: {
      phone_number: {
        type: 'string',
        description: 'The phone number to call (E.164 format preferred, e.g. +12125551234)',
      },
      purpose: {
        type: 'string',
        description: 'What to say/ask when they pick up — Atlas uses this as context for the conversation',
      },
      caller_id: {
        type: 'string',
        description: 'Optional: caller ID number to display. Defaults to the Atlas Twilio number.',
      },
    },
    required: ['phone_number', 'purpose'],
  },
  enabled: true,
  builtIn: true,

  formatApproval(input: { phone_number: string; purpose: string }): string {
    return `📞 *Outbound Call*\nTo: ${input.phone_number}\nPurpose: ${input.purpose}`;
  },

  async execute(
    input: { phone_number: string; purpose: string; caller_id?: string },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    try {
      const env = getEnv();

      // Normalize phone number — ensure E.164
      let targetPhone = input.phone_number.replace(/[\s\-()]/g, '');
      if (!targetPhone.startsWith('+')) {
        // Assume US number if no country code
        targetPhone = targetPhone.startsWith('1') ? `+${targetPhone}` : `+1${targetPhone}`;
      }

      const fromNumber = input.caller_id || env.TWILIO_WHATSAPP_NUMBER.replace('whatsapp:', '');

      logger.info('make_call: initiating outbound call', {
        to: targetPhone,
        from: fromNumber,
        purpose: input.purpose.slice(0, 100),
      });

      const callSid = await initiateOutboundCall(targetPhone, fromNumber, input.purpose);

      return {
        success: true,
        data: {
          message: `Call initiated to ${targetPhone}. Atlas will greet them and handle the conversation.`,
          callSid,
          targetPhone,
          purpose: input.purpose,
        },
      };
    } catch (err) {
      logger.error('make_call failed', { error: err, phone: input.phone_number });
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

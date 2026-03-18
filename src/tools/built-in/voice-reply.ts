import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { textToSpeech, type TTSVoice } from '../../services/tts.js';
import logger from '../../utils/logger.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getEnv } from '../../config/env.js';

export const voiceReplyTool: ToolDefinition = {
  name: 'voice_reply',
  description: 'Send a voice message (text-to-speech) to JP via WhatsApp or Telegram. Use when: JP sent a voice note, JP asks to "read aloud" or "tell me", or for long content better consumed as audio.',
  category: 'action',
  requiresApproval: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      text: { type: 'string', description: 'The text to convert to speech and send' },
      voice: {
        type: 'string',
        enum: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
        description: 'Voice style (default: alloy)',
      },
    },
    required: ['text'],
  },
  enabled: true,
  builtIn: true,

  async execute(
    input: { text: string; voice?: TTSVoice },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    try {
      const voice = input.voice || 'alloy';
      const audioBuffer = await textToSpeech(input.text, voice);

      // Save to temp file for Twilio to serve
      const filename = `voice_${crypto.randomBytes(8).toString('hex')}.mp3`;
      const tempDir = '/tmp/atlas-voice';
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
      const filePath = path.join(tempDir, filename);
      fs.writeFileSync(filePath, audioBuffer);

      // For WhatsApp via Twilio, we need a publicly accessible URL
      // Use the Atlas server to serve the file temporarily
      const baseUrl = getEnv().BASE_URL;
      const mediaUrl = `${baseUrl}/media/voice/${filename}`;

      // Send via Twilio with media URL
      // Note: The route /media/voice/:filename must be set up to serve from /tmp/atlas-voice/
      if (ctx.channel === 'telegram') {
        // For Telegram, send as voice message via grammY
        const { sendTelegramVoice } = await import('../../services/telegram.js');
        const chatId = ctx.userPhone.replace(/^tg:/, '');
        await sendTelegramVoice(chatId, audioBuffer);
      } else {
        // WhatsApp: send via Twilio media message
        const twilio = await import('twilio');
        const env = getEnv();
        const client = twilio.default(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
        await client.messages.create({
          from: env.TWILIO_WHATSAPP_NUMBER,
          to: ctx.userPhone.startsWith('whatsapp:') ? ctx.userPhone : `whatsapp:${ctx.userPhone}`,
          mediaUrl: [mediaUrl],
          body: '',
        });
      }

      // Clean up after 5 minutes
      setTimeout(() => {
        try { fs.unlinkSync(filePath); } catch {}
      }, 5 * 60 * 1000);

      return {
        success: true,
        data: {
          message: 'Voice message sent',
          textLength: input.text.length,
          voice,
          audioSizeKb: Math.round(audioBuffer.length / 1024),
        },
      };
    } catch (err) {
      logger.error('Voice reply failed', { error: err });
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { processVideoUrl, processTelegramVideo, detectVideoUrl } from '../../services/video.js';
import { sendTelegramMessage } from '../../services/telegram.js';
import logger from '../../utils/logger.js';

export const summarizeVideoTool: ToolDefinition = {
  name: 'summarize_video',
  description: 'Download and transcribe a YouTube or Instagram video, then return the full transcript for summarization. Supports YouTube videos/shorts/live and Instagram reels/posts/TV. Also handles Telegram video file IDs. Use when the user sends a video link or forwards a video.',
  category: 'informational',
  requiresApproval: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      url: {
        type: 'string',
        description: 'The YouTube or Instagram video URL',
      },
      telegram_file_id: {
        type: 'string',
        description: 'Telegram file_id for a video sent directly in chat',
      },
    },
    required: [],
  },
  enabled: true,
  builtIn: true,

  async execute(
    input: { url?: string; telegram_file_id?: string },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const startTime = Date.now();

    if (!input.url && !input.telegram_file_id) {
      return { success: false, error: 'Provide either a video URL or a telegram_file_id' };
    }

    try {
      // Send status so user knows we're working
      if (ctx.channel === 'telegram') {
        const chatId = ctx.userPhone.replace(/^tg:/, '');
        await sendTelegramMessage(chatId, '🎬 Processing video...').catch(() => {});
      }

      let result;

      if (input.telegram_file_id) {
        logger.info('Processing Telegram video', { fileId: input.telegram_file_id });
        result = await processTelegramVideo(input.telegram_file_id);
      } else if (input.url) {
        const video = detectVideoUrl(input.url);
        if (!video) {
          return {
            success: false,
            error: 'Not a recognized video URL. Supported: YouTube (youtube.com, youtu.be, shorts) and Instagram (reels, posts, TV).',
          };
        }
        logger.info('Processing video URL', { url: input.url, platform: video.platform });
        result = await processVideoUrl(input.url);
      } else {
        return { success: false, error: 'No URL or file_id provided' };
      }

      // Truncate very long transcripts to fit in Claude context
      const maxLen = 30_000;
      const transcript = result.transcript.length > maxLen
        ? result.transcript.slice(0, maxLen) + `\n\n[...truncated — ${result.transcript.length} total chars]`
        : result.transcript;

      const durationStr = result.duration > 0
        ? `${Math.floor(result.duration / 60)}m${result.duration % 60}s`
        : 'unknown';

      logger.info('Video processed', {
        title: result.title,
        platform: result.platform,
        method: result.method,
        duration: durationStr,
        transcriptLen: result.transcript.length,
        ms: Date.now() - startTime,
      });

      return {
        success: true,
        data: {
          title: result.title,
          platform: result.platform,
          duration: durationStr,
          method: result.method,
          url: result.url || undefined,
          transcriptLength: result.transcript.length,
          transcript,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('Video summarization failed', { error: msg, url: input.url });
      return { success: false, error: `Video processing failed: ${msg}` };
    }
  },
};

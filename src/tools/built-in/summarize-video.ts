import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { processVideoUrl, processTelegramVideo, detectVideoUrl, containsVideoUrl } from '../../services/video.js';
import { sendTelegramMessage } from '../../services/telegram.js';
import logger from '../../utils/logger.js';

export const summarizeVideoTool: ToolDefinition = {
  name: 'summarize_video',
  description: 'Download and transcribe a YouTube or Instagram video, then return the full transcript for summarization. Supports YouTube videos/shorts/live and Instagram reels/posts/TV. Use this when the user sends a video link and wants a summary, key points, or analysis of the video content.',
  category: 'informational',
  requiresApproval: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      url: {
        type: 'string',
        description: 'The YouTube or Instagram video URL to summarize',
      },
      telegram_file_id: {
        type: 'string',
        description: 'Telegram file_id for a forwarded video (use instead of URL when a video file was sent directly)',
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

    try {
      // Send a "processing" status message so the user knows we're working
      if (ctx.channel === 'telegram') {
        const chatId = ctx.userPhone.replace(/^tg:/, '');
        await sendTelegramMessage(chatId, '🎬 Processing video... This may take a moment.').catch(() => {});
      }

      let result;

      if (input.telegram_file_id) {
        logger.info('Processing Telegram video file', { fileId: input.telegram_file_id });
        result = await processTelegramVideo(input.telegram_file_id);
      } else if (input.url) {
        const video = detectVideoUrl(input.url);
        if (!video) {
          return { success: false, error: 'Not a recognized video URL. Supported: YouTube (youtube.com, youtu.be, shorts) and Instagram (reels, posts, TV).' };
        }
        logger.info('Processing video URL', { url: input.url, platform: video.platform });
        result = await processVideoUrl(input.url);
      } else {
        return { success: false, error: 'Provide either a video URL or a telegram_file_id' };
      }

      const durationMin = result.duration > 0 ? `${Math.round(result.duration / 60)} min` : 'unknown';
      const transcriptLen = result.transcript.length;

      // Truncate very long transcripts for Claude context (keep first 30K chars)
      const maxTranscript = 30_000;
      const transcript = transcriptLen > maxTranscript
        ? result.transcript.slice(0, maxTranscript) + `\n\n[... transcript truncated at ${maxTranscript} chars — total ${transcriptLen} chars]`
        : result.transcript;

      logger.info('Video processed', {
        title: result.title,
        platform: result.platform,
        duration: durationMin,
        transcriptLength: transcriptLen,
        processingMs: Date.now() - startTime,
      });

      return {
        success: true,
        data: {
          title: result.title,
          platform: result.platform,
          duration: durationMin,
          url: result.url,
          transcriptLength: transcriptLen,
          transcript,
          instruction: 'The above is the full transcript of the video. Provide a comprehensive summary covering: main topic, key points, notable quotes, and conclusions. Format it clearly for the user.',
        },
      };
    } catch (err) {
      logger.error('Video summarization failed', { error: err, url: input.url });
      return {
        success: false,
        error: `Failed to process video: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

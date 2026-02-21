import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { generateImage } from '../../services/image-gen.js';
import logger from '../../utils/logger.js';

export const generateImageTool: ToolDefinition = {
  name: 'generate_image',
  description: 'Generate an image using DALL-E 3 and send it to JP via WhatsApp. Use for creative requests, visualizations, or when JP asks for an image.',
  category: 'action',
  requiresApproval: true,
  inputSchema: {
    type: 'object' as const,
    properties: {
      prompt: { type: 'string', description: 'Detailed description of the image to generate' },
      size: { type: 'string', enum: ['1024x1024', '1024x1792', '1792x1024'], description: 'Image size (default square)' },
    },
    required: ['prompt'],
  },
  enabled: true,
  builtIn: true,

  formatApproval(input: { prompt: string; size?: string }) {
    return `I'd like to generate an image:\n\n*Prompt:* ${input.prompt}\n*Size:* ${input.size || '1024x1024'}\n\nReply: *1* — Generate  *2* — Edit prompt  *3* — Cancel`;
  },

  async execute(input: { prompt: string; size?: string }, ctx: ToolContext): Promise<ToolResult> {
    try {
      const size = (input.size || '1024x1024') as '1024x1024' | '1024x1792' | '1792x1024';
      const imageUrl = await generateImage(input.prompt, size);

      return {
        success: true,
        data: { imageUrl, prompt: input.prompt, size },
      };
    } catch (err) {
      logger.error('Image generation error', { error: err });
      return { success: false, error: err instanceof Error ? err.message : 'Image generation failed' };
    }
  },
};

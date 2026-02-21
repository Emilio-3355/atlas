import Anthropic from '@anthropic-ai/sdk';
import { getEnv } from '../config/env.js';
import type { ReasoningDepth } from '../types/index.js';
import logger from '../utils/logger.js';

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: getEnv().ANTHROPIC_API_KEY });
  }
  return client;
}

interface ClaudeRequest {
  messages: Anthropic.MessageParam[];
  system: string;
  tools?: Anthropic.Tool[];
  depth: ReasoningDepth;
  maxTokens?: number;
}

interface ClaudeResponse {
  content: Anthropic.ContentBlock[];
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}

const MODEL_CONFIG: Record<ReasoningDepth, { model: string; maxTokens: number }> = {
  fast: { model: 'claude-sonnet-4-6', maxTokens: 1024 },
  deep: { model: 'claude-sonnet-4-6', maxTokens: 4096 },
  expert: { model: 'claude-opus-4-6', maxTokens: 8192 },
};

export async function callClaude(req: ClaudeRequest): Promise<ClaudeResponse> {
  const config = MODEL_CONFIG[req.depth];
  const maxTokens = req.maxTokens || config.maxTokens;

  logger.debug('Calling Claude', { depth: req.depth, model: config.model, messageCount: req.messages.length });

  const params: Anthropic.MessageCreateParams = {
    model: config.model,
    max_tokens: maxTokens,
    system: req.system,
    messages: req.messages,
  };

  if (req.tools && req.tools.length > 0) {
    params.tools = req.tools;
  }

  // Enable extended thinking for deep/expert
  if (req.depth === 'deep' || req.depth === 'expert') {
    params.thinking = { type: 'enabled', budget_tokens: Math.floor(maxTokens * 0.6) };
    // When thinking is enabled, max_tokens must accommodate both thinking + output
    params.max_tokens = maxTokens + Math.floor(maxTokens * 0.6);
  }

  const response = await getClient().messages.create(params);

  return {
    content: response.content,
    stopReason: response.stop_reason,
    usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
    model: response.model,
  };
}

export function extractTextContent(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

export function extractToolUse(content: Anthropic.ContentBlock[]): Anthropic.ToolUseBlock | null {
  return (content.find((block) => block.type === 'tool_use') as Anthropic.ToolUseBlock) || null;
}

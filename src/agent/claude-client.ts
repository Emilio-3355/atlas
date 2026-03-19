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

const MAX_RETRIES = 2;
const RETRY_DELAYS = [1000, 3000]; // ms

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

  // Timeout per depth: fast=60s, deep=120s, expert=180s
  const timeoutMs = req.depth === 'fast' ? 60_000 : req.depth === 'deep' ? 120_000 : 180_000;

  // Retry with exponential backoff for transient errors
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS[attempt - 1] || 3000;
      logger.warn('Retrying Claude API call', { attempt, delay, depth: req.depth });
      await new Promise((r) => setTimeout(r, delay));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await getClient().messages.create(params, { signal: controller.signal as any });
      clearTimeout(timer);

      return {
        content: response.content,
        stopReason: response.stop_reason,
        usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
        model: response.model,
      };
    } catch (err: any) {
      clearTimeout(timer);
      lastError = err instanceof Error ? err : new Error(String(err));

      // Only retry on transient errors (429, 500, 502, 503, 529, timeouts)
      const status = err?.status || err?.statusCode;
      const isTransient = status === 429 || status === 500 || status === 502 || status === 503 || status === 529
        || err?.name === 'AbortError' || err?.code === 'ECONNRESET' || err?.code === 'ETIMEDOUT';

      if (!isTransient || attempt === MAX_RETRIES) {
        throw lastError;
      }
    }
  }

  throw lastError || new Error('Claude API call failed after retries');
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

export function extractAllToolUse(content: Anthropic.ContentBlock[]): Anthropic.ToolUseBlock[] {
  return content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
}

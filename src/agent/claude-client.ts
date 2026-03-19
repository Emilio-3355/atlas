import Anthropic from '@anthropic-ai/sdk';
import { getEnv } from '../config/env.js';
import { isDaemonOnline, sendCommand } from '../services/daemon-bridge.js';
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

/**
 * Main entry point: tries daemon (Max plan, free) first, falls back to API.
 *
 * Daemon routing is used when:
 * - Daemon is online
 * - No tools are needed (text-only response)
 * - No images in messages (daemon can't handle multimodal)
 * - Depth is 'fast' (keep complex reasoning on API for reliability)
 *
 * Everything else goes through the API key as usual.
 */
export async function callClaude(req: ClaudeRequest): Promise<ClaudeResponse> {
  // Check if we can route through daemon (free via Max plan)
  const canUseDaemon = isDaemonOnline()
    && (!req.tools || req.tools.length === 0)
    && !hasImages(req.messages)
    && req.depth === 'fast';

  if (canUseDaemon) {
    try {
      const result = await callClaudeViaDaemon(req);
      if (result) return result;
    } catch (err) {
      logger.warn('Daemon Claude call failed, falling back to API', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Fall back to direct API call
  return callClaudeViaAPI(req);
}

/** Check if any message contains image content blocks */
function hasImages(messages: Anthropic.MessageParam[]): boolean {
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ((block as any).type === 'image') return true;
      }
    }
  }
  return false;
}

/**
 * Route through Mac daemon → Claude Code CLI (uses Max subscription, free).
 * Constructs a prompt from system + messages and sends to `claude -p`.
 */
async function callClaudeViaDaemon(req: ClaudeRequest): Promise<ClaudeResponse | null> {
  // Build a comprehensive prompt from system + conversation
  const parts: string[] = [];
  parts.push(`<system>\n${req.system}\n</system>\n`);

  for (const msg of req.messages) {
    const role = msg.role === 'user' ? 'Human' : 'Assistant';
    const content = typeof msg.content === 'string'
      ? msg.content
      : (msg.content as any[]).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    if (content.trim()) {
      parts.push(`${role}: ${content}`);
    }
  }

  const prompt = parts.join('\n\n');

  logger.info('Routing through daemon (Max plan)', { messageCount: req.messages.length, promptLength: prompt.length });

  const result = await sendCommand({
    action: 'claude_code',
    prompt,
    timeout: 60,
  });

  if (!result.success || !result.output?.trim()) {
    logger.warn('Daemon returned empty/failed response', { success: result.success, outputLength: result.output?.length });
    return null; // Fall back to API
  }

  // Convert plain text response to Anthropic ContentBlock format
  return {
    content: [{ type: 'text', text: result.output.trim(), citations: null } as unknown as Anthropic.ContentBlock],
    stopReason: 'end_turn',
    usage: { inputTokens: 0, outputTokens: 0 }, // No API cost!
    model: 'claude-code-daemon',
  };
}

/** Direct Anthropic API call (paid per token) */
async function callClaudeViaAPI(req: ClaudeRequest): Promise<ClaudeResponse> {
  const config = MODEL_CONFIG[req.depth];
  const maxTokens = req.maxTokens || config.maxTokens;

  logger.debug('Calling Claude API', { depth: req.depth, model: config.model, messageCount: req.messages.length });

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

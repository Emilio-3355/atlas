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

export interface ClaudeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;  // tokens written to cache (billed at 1.25x input)
  cacheReadTokens: number;      // tokens read from cache (billed at 0.1x input)
}

interface ClaudeResponse {
  content: Anthropic.ContentBlock[];
  stopReason: string | null;
  usage: ClaudeUsage;
  model: string;
}

const MODEL_CONFIG: Record<ReasoningDepth, { model: string; maxTokens: number }> = {
  voice: { model: 'claude-haiku-4-5-20251001', maxTokens: 256 },
  fast: { model: 'claude-sonnet-4-6', maxTokens: 2048 },
  deep: { model: 'claude-sonnet-4-6', maxTokens: 8192 },
  expert: { model: 'claude-opus-4-6', maxTokens: 16384 },
};

const MAX_RETRIES = 2;
const RETRY_DELAYS = [1000, 3000]; // ms

/**
 * Main entry point: tries daemon (Max subscription, free) first, falls back to API.
 *
 * Daemon-first strategy — maximize subscription usage, minimize API spend:
 * 1. If daemon is online and no images → try daemon first (any depth, tools or not)
 * 2. If daemon response looks complete (no tool intent) → use it
 * 3. If daemon response indicates it needs tools, or daemon fails → fall back to API
 *
 * Only images are hard-blocked from daemon (can't send multimodal via CLI).
 * API is used as fallback when daemon is offline, fails, or tools are genuinely needed.
 */
export async function callClaude(req: ClaudeRequest): Promise<ClaudeResponse> {
  // Skip daemon for voice — direct API is faster (daemon adds CLI overhead)
  const canTryDaemon = isDaemonOnline() && !hasImages(req.messages) && req.depth !== 'voice';

  if (canTryDaemon) {
    try {
      const result = await callClaudeViaDaemon(req);
      if (result) {
        // If tools were available and daemon response suggests it wanted to use one,
        // fall back to API so tools actually fire
        if (req.tools && req.tools.length > 0 && looksLikeToolIntent(result.content)) {
          logger.info('Daemon response has tool intent — falling back to API for tool execution');
        } else {
          return result;
        }
      }
    } catch (err) {
      logger.warn('Daemon Claude call failed, falling back to API', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Fall back to direct API call
  return callClaudeViaAPI(req);
}

/**
 * Detect if daemon response text indicates Atlas wanted to use a tool but couldn't.
 * These patterns suggest the query needs real tool execution via the API.
 */
function looksLikeToolIntent(content: Anthropic.ContentBlock[]): boolean {
  const text = content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .toLowerCase();

  // Patterns that indicate the response wanted to use tools
  const toolIntentPatterns = [
    /\b(let me|i('ll| will)|i need to|i('d| would) need to)\s+(search|look up|check|browse|fetch|query|use|call|run|open|access|get|find|look for|pull up)/,
    /\b(searching|looking up|checking|fetching|browsing|querying)\b.*\b(for you|now|right now)\b/,
    /\bi('ll| will) use (the |my )?(web.?search|browse|stock|remember|site.?login|summarize|financial|sec|earnings|local.?exec|server.?shell)\b/,
    /\bunfortunately.{0,30}(i can'?t|i'?m unable|i don'?t have).{0,40}(access|search|browse|look up|check|real.?time)/,
    /\bi don'?t have (access to |the ability to )?(real.?time|current|live|up.?to.?date|latest)\b/,
    /\b(current|real.?time|live|latest) (stock |market )?(price|data|quote|information)\b.*\b(not available|can'?t|unable)\b/,
  ];

  return toolIntentPatterns.some((p) => p.test(text));
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

  // Scale timeout by depth: voice=15s, fast=60s, deep=120s, expert=180s
  const timeout = req.depth === 'voice' ? 15 : req.depth === 'fast' ? 60 : req.depth === 'deep' ? 120 : 180;

  logger.info('Routing through daemon (Max subscription)', {
    depth: req.depth,
    messageCount: req.messages.length,
    promptLength: prompt.length,
    hasTools: !!(req.tools && req.tools.length > 0),
    timeout,
  });

  const result = await sendCommand({
    action: 'claude_code',
    prompt,
    timeout,
  });

  if (!result.success || !result.output?.trim()) {
    logger.warn('Daemon returned empty/failed response', { success: result.success, outputLength: result.output?.length });
    return null; // Fall back to API
  }

  // Convert plain text response to Anthropic ContentBlock format
  return {
    content: [{ type: 'text', text: result.output.trim(), citations: null } as unknown as Anthropic.ContentBlock],
    stopReason: 'end_turn',
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, // No API cost!
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

  // Timeout per depth: voice=15s, fast=60s, deep=120s, expert=180s
  const timeoutMs = req.depth === 'voice' ? 15_000 : req.depth === 'fast' ? 60_000 : req.depth === 'deep' ? 120_000 : 180_000;

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
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheCreationTokens: response.usage.cache_creation_input_tokens || 0,
          cacheReadTokens: response.usage.cache_read_input_tokens || 0,
        },
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

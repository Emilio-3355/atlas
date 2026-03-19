import type { OnErrorHook, HookContext } from './types.js';
import { getToolAdvice } from '../self-improvement/learning-engine.js';
import logger from '../utils/logger.js';

// Error classification (inspired by OpenClaw's failover-error.ts)
type ErrorClass = 'transient' | 'auth' | 'rate_limit' | 'timeout' | 'not_found' | 'captcha' | 'permanent' | 'unknown';

function classifyError(error: Error): ErrorClass {
  const msg = error.message.toLowerCase();
  const cause = (error as any).cause?.message?.toLowerCase() || '';
  const combined = `${msg} ${cause}`;

  // Rate limiting
  if (combined.includes('rate limit') || combined.includes('429') || combined.includes('too many requests') || combined.includes('resource_exhausted')) {
    return 'rate_limit';
  }

  // Auth failures
  if (combined.includes('401') || combined.includes('403') || combined.includes('unauthorized') || combined.includes('forbidden') || combined.includes('invalid api key') || combined.includes('authentication')) {
    return 'auth';
  }

  // Timeouts and network issues
  if (combined.includes('timeout') || combined.includes('etimedout') || combined.includes('econnreset') || combined.includes('econnrefused') || combined.includes('eai_again') || combined.includes('abort') || combined.includes('socket hang up')) {
    return 'timeout';
  }

  // CAPTCHA / bot detection
  if (combined.includes('captcha') || combined.includes('unusual traffic') || combined.includes('not a robot') || combined.includes('recaptcha') || combined.includes('cloudflare')) {
    return 'captcha';
  }

  // Not found
  if (combined.includes('404') || combined.includes('not found') || combined.includes('no such')) {
    return 'not_found';
  }

  // Transient server errors
  if (combined.includes('500') || combined.includes('502') || combined.includes('503') || combined.includes('504') || combined.includes('overloaded') || combined.includes('temporarily')) {
    return 'transient';
  }

  return 'unknown';
}

// Smart error handling with classification and escalation
export const smartErrorHandler: OnErrorHook = async (error: Error, ctx: HookContext) => {
  const errorClass = classifyError(error);

  logger.info('Error classified', { tool: ctx.toolName, class: errorClass, error: error.message });

  // Transient + timeout + rate_limit → retry
  if (errorClass === 'transient' || errorClass === 'timeout' || errorClass === 'rate_limit') {
    return { retry: true };
  }

  // CAPTCHA → tell agent to try different approach (don't retry same URL)
  if (errorClass === 'captcha') {
    return {
      retry: false,
      fallback: `${ctx.toolName} was blocked by CAPTCHA/bot detection. Try a different URL or approach — for example, use DuckDuckGo search or browse a different site directly.`,
    };
  }

  // Auth → don't retry, surface to user
  if (errorClass === 'auth') {
    return {
      retry: false,
      fallback: `Authentication error with ${ctx.toolName}: ${error.message}. The API key or credentials may need to be updated.`,
    };
  }

  // Check if we have past advice for this tool
  const advice = await getToolAdvice(ctx.toolName);
  if (advice) {
    return {
      retry: false,
      fallback: `Error with ${ctx.toolName}. ${advice}\nLet me try a different approach.`,
    };
  }

  // Unknown error — encourage agent to try alternatives
  return {
    retry: false,
    fallback: `${ctx.toolName} failed: ${error.message}. Try a different tool or approach.`,
  };
};

import type { PreResponseHook } from './types.js';
import type { ToolContext } from '../types/index.js';

// Quality gate before sending to JP
export const qualityGate: PreResponseHook = async (response: string, ctx: ToolContext): Promise<string> => {
  // Strip any accidental system prompt leaks
  const sensitivePatterns = [
    /ABSOLUTE SECURITY RULES/gi,
    /system\s*prompt/gi,
    /ANTHROPIC_API_KEY/gi,
    /sk-ant-/gi,
    /TWILIO_AUTH_TOKEN/gi,
  ];

  let cleaned = response;
  for (const pattern of sensitivePatterns) {
    if (pattern.test(cleaned)) {
      cleaned = cleaned.replace(pattern, '[REDACTED]');
    }
  }

  // Ensure response isn't empty
  if (!cleaned.trim()) {
    cleaned = ctx.language === 'es' ? 'Listo.' : 'Done.';
  }

  return cleaned;
};

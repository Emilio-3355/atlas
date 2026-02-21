import type { TrustLevel } from '../types/index.js';
import logger from '../utils/logger.js';

// Wrap external content with trust markers so the LLM knows what to trust
export function tagContent(content: string, trust: TrustLevel, source: string): string {
  return `<external_content trust="${trust}" source="${source}">\n${content}\n</external_content>`;
}

// Detect potential prompt injection in external content
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /you\s+are\s+now\s+/i,
  /new\s+instructions?\s*:/i,
  /system\s*:\s*/i,
  /forget\s+(everything|all|your\s+instructions)/i,
  /disregard\s+(all|your|the)\s+(previous|prior|above)/i,
  /override\s+(your|the|all)\s+(instructions|rules|prompt)/i,
  /pretend\s+(you\s+are|to\s+be)/i,
  /do\s+not\s+follow\s+(your|the)\s+(instructions|rules)/i,
  /\bsudo\b/i,
  /\bact\s+as\b/i,
  /\broleplay\s+as\b/i,
  /reveal\s+(your|the)\s+(system|prompt|instructions)/i,
  /what\s+are\s+your\s+(instructions|rules|system\s+prompt)/i,
  /forward\s+this\s+(email|message)\s+to/i,
  /send\s+(this|an?\s+email)\s+to/i,
  /click\s+(here|this\s+link)/i,
];

export function detectInjection(content: string): { detected: boolean; patterns: string[] } {
  const found: string[] = [];
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(content)) {
      found.push(pattern.source);
    }
  }
  if (found.length > 0) {
    logger.warn('Potential prompt injection detected', { patterns: found });
  }
  return { detected: found.length > 0, patterns: found };
}

/**
 * Tool Security Policies — NemoClaw-inspired deny-by-default framework.
 *
 * Each tool has a policy that defines:
 * - Whether it's allowed at all
 * - Whether it requires user approval
 * - What inputs are restricted (e.g., blocked URL patterns, blocked commands)
 * - Rate limits per tool
 *
 * This prevents compromised/hallucinated tool calls from doing damage.
 */

import logger from '../utils/logger.js';

interface ToolPolicy {
  /** Whether this tool is allowed to execute */
  allowed: boolean;
  /** Whether execution requires user approval */
  requiresApproval: boolean;
  /** Maximum calls per hour (0 = unlimited) */
  maxCallsPerHour: number;
  /** Input validation rules */
  inputRules?: InputRule[];
}

interface InputRule {
  field: string;
  /** Block if input matches any of these patterns */
  blockPatterns?: RegExp[];
  /** Only allow if input matches one of these patterns */
  allowPatterns?: RegExp[];
  /** Maximum length for string inputs */
  maxLength?: number;
}

// Tool call counters for rate limiting
const toolCallCounts = new Map<string, { count: number; resetAt: number }>();

// Default policies — deny-by-default, explicit allow
const policies: Record<string, ToolPolicy> = {
  // === Informational (safe, no approval needed) ===
  web_search: { allowed: true, requiresApproval: false, maxCallsPerHour: 60 },
  browse: {
    allowed: true,
    requiresApproval: false,
    maxCallsPerHour: 30,
    inputRules: [{
      field: 'url',
      blockPatterns: [
        /^file:\/\//i,          // No local file access
        /^javascript:/i,        // No JS execution
        /^data:text\/html/i,    // No data URL HTML injection
        /localhost|127\.\d+\.\d+\.\d+/i, // No SSRF to any loopback (127.0.0.0/8)
        /\b0\.0\.0\.0\b/,              // No unspecified address
        /\[?::1\]?/,                   // No IPv6 loopback
        /0x7f[0-9a-f]{6}/i,           // No hex-encoded 127.x.x.x
        /0177\.\d+\.\d+\.\d+/,        // No octal-encoded loopback
        /%6c%6f%63%61%6c%68%6f%73%74/i, // No URL-encoded "localhost"
        /%31%32%37/i,                  // No URL-encoded "127" in IP
        /\b2130706433\b/,             // No decimal representation of 127.0.0.1
        /169\.254\./,                  // No AWS metadata / link-local
        /10\.\d+\.\d+\.\d+/,          // No 10.x private
        /172\.(1[6-9]|2\d|3[01])\.\d+\.\d+/, // No 172.16-31.x private
        /192\.168\.\d+\.\d+/,         // No 192.168.x private
      ],
    }],
  },
  screenshot: { allowed: true, requiresApproval: false, maxCallsPerHour: 20 },
  read_pdf: { allowed: true, requiresApproval: false, maxCallsPerHour: 20 },
  recall: { allowed: true, requiresApproval: false, maxCallsPerHour: 60 },
  remember: { allowed: true, requiresApproval: false, maxCallsPerHour: 30 },
  reflect: { allowed: true, requiresApproval: false, maxCallsPerHour: 10 },
  stock_price: { allowed: true, requiresApproval: false, maxCallsPerHour: 60 },
  sec_filings: { allowed: true, requiresApproval: false, maxCallsPerHour: 30 },
  financial_data: { allowed: true, requiresApproval: false, maxCallsPerHour: 30 },
  earnings_analysis: { allowed: true, requiresApproval: false, maxCallsPerHour: 10 },
  summarize_video: { allowed: true, requiresApproval: false, maxCallsPerHour: 10 },
  project_memory: { allowed: true, requiresApproval: false, maxCallsPerHour: 30 },
  voice_reply: { allowed: true, requiresApproval: false, maxCallsPerHour: 20 },

  // === Actions (require approval) ===
  send_email: { allowed: true, requiresApproval: true, maxCallsPerHour: 20 },
  calendar_create: { allowed: true, requiresApproval: true, maxCallsPerHour: 20 },
  fill_form: { allowed: true, requiresApproval: true, maxCallsPerHour: 10 },
  book_reservation: { allowed: true, requiresApproval: true, maxCallsPerHour: 10 },
  site_login: { allowed: true, requiresApproval: true, maxCallsPerHour: 10 },

  // === Read-only calendar/email (no approval) ===
  read_email: { allowed: true, requiresApproval: false, maxCallsPerHour: 30 },
  calendar_read: { allowed: true, requiresApproval: false, maxCallsPerHour: 30 },
  remind: { allowed: true, requiresApproval: false, maxCallsPerHour: 20 },
  schedule_task: { allowed: true, requiresApproval: false, maxCallsPerHour: 20 },

  // === Sensitive (require approval + strict limits) ===
  server_shell: {
    allowed: true,
    requiresApproval: true,
    maxCallsPerHour: 10,
    inputRules: [{
      field: 'command',
      blockPatterns: [
        /rm\s+(-rf?|--force)/i,     // No destructive deletes
        /dd\s+if=/i,                  // No disk overwrites
        /mkfs/i,                      // No filesystem creation
        /shutdown|reboot|halt/i,      // No server shutdown
        /passwd|useradd|userdel/i,    // No user management
        /iptables|ufw/i,             // No firewall changes
        /curl.*\|\s*(bash|sh)/i,     // No pipe-to-shell
        /wget.*\|\s*(bash|sh)/i,
      ],
    }],
  },
  local_exec: {
    allowed: true,
    requiresApproval: true,
    maxCallsPerHour: 20,
    inputRules: [{
      field: 'command',
      blockPatterns: [
        /rm\s+(-rf?|--force)/i,
        /sudo\s/i,                   // No sudo on Mac
        /curl.*\|\s*(bash|sh)/i,
        /osascript.*delete/i,        // No AppleScript deletion
      ],
    }],
  },
  filesystem: {
    allowed: true,
    requiresApproval: true,
    maxCallsPerHour: 30,
    inputRules: [{
      field: 'path',
      blockPatterns: [
        /\.\.\//,                    // No path traversal
        /\/etc\//,                   // No system config
        /\/proc\//,                  // No process info
        /\.env/i,                    // No env files
        /\.ssh\//,                   // No SSH keys
      ],
    }],
  },

  // === Code generation (require approval) ===
  code_forge: { allowed: true, requiresApproval: true, maxCallsPerHour: 5 },
  spawn_agent: { allowed: true, requiresApproval: true, maxCallsPerHour: 10 },
  propose_tool: { allowed: true, requiresApproval: false, maxCallsPerHour: 5 },
  propose_workflow: { allowed: true, requiresApproval: false, maxCallsPerHour: 5 },

  // === Image generation ===
  generate_image: { allowed: true, requiresApproval: false, maxCallsPerHour: 10 },

  // === Browser network tools ===
  browser_network_observe: { allowed: true, requiresApproval: false, maxCallsPerHour: 30 },
  browser_network_intercept: { allowed: true, requiresApproval: true, maxCallsPerHour: 10 },
  browser_network_clear: { allowed: true, requiresApproval: false, maxCallsPerHour: 30 },
};

/** Check if a tool call is allowed by policy */
export function checkToolPolicy(toolName: string, input: Record<string, any>): { allowed: boolean; reason?: string } {
  const policy = policies[toolName];

  // Unknown tools — deny by default (NemoClaw principle)
  if (!policy) {
    logger.warn('Unknown tool denied by policy', { tool: toolName });
    return { allowed: false, reason: `Unknown tool '${toolName}' denied by default policy` };
  }

  if (!policy.allowed) {
    return { allowed: false, reason: `Tool ${toolName} is disabled by policy` };
  }

  // Rate limiting
  const now = Date.now();
  const key = toolName;
  let counter = toolCallCounts.get(key);
  if (!counter || now > counter.resetAt) {
    counter = { count: 0, resetAt: now + 3600_000 };
    toolCallCounts.set(key, counter);
  }
  counter.count++;

  if (policy.maxCallsPerHour > 0 && counter.count > policy.maxCallsPerHour) {
    return { allowed: false, reason: `Tool ${toolName} rate limited (${policy.maxCallsPerHour}/hour). Wait before retrying.` };
  }

  // Input validation
  if (policy.inputRules) {
    for (const rule of policy.inputRules) {
      const value = input[rule.field];
      // Block non-string inputs — arrays/objects/null can bypass pattern checks
      if (value === undefined) continue; // Field not provided — skip
      if (typeof value !== 'string') {
        return { allowed: false, reason: `Input ${rule.field} must be a string, got ${value === null ? 'null' : typeof value}` };
      }

      if (rule.maxLength && value.length > rule.maxLength) {
        return { allowed: false, reason: `Input ${rule.field} exceeds max length (${rule.maxLength})` };
      }

      if (rule.blockPatterns) {
        for (const pattern of rule.blockPatterns) {
          if (pattern.test(value)) {
            logger.warn('Tool input blocked by policy', { tool: toolName, field: rule.field, pattern: pattern.source });
            return { allowed: false, reason: `Input blocked by security policy: ${rule.field} contains restricted pattern` };
          }
        }
      }

      if (rule.allowPatterns && rule.allowPatterns.length > 0) {
        const matches = rule.allowPatterns.some(p => p.test(value));
        if (!matches) {
          return { allowed: false, reason: `Input ${rule.field} doesn't match any allowed pattern` };
        }
      }
    }
  }

  return { allowed: true };
}

/** Get the policy for a specific tool */
export function getToolPolicy(toolName: string): ToolPolicy | undefined {
  return policies[toolName];
}

/** Reset rate limit counters (for testing) */
export function resetRateLimits(): void {
  toolCallCounts.clear();
}

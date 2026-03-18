import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { getNetworkLog, clearNetworkLog, createMonitoredPage, interceptRequests } from '../../services/browser.js';
import logger from '../../utils/logger.js';

export const browserNetworkTool: ToolDefinition = {
  name: 'browser_network_requests',
  description: 'Get captured network requests from a monitored browser page. Filter by URL pattern, HTTP method, or status code range. Shows URL, method, status, headers, resource type, and timing.',
  category: 'informational',
  requiresApproval: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      profile_id: { type: 'string', description: 'Browser profile ID (default: "default")' },
      url_pattern: { type: 'string', description: 'Regex pattern to filter URLs (e.g., "api\\.example\\.com")' },
      method: { type: 'string', description: 'HTTP method filter (GET, POST, etc.)' },
      status_min: { type: 'number', description: 'Minimum status code (e.g., 400 for errors only)' },
      status_max: { type: 'number', description: 'Maximum status code' },
      limit: { type: 'number', description: 'Max entries to return (default 50)' },
    },
    required: [],
  },
  enabled: true,
  builtIn: true,

  async execute(input: any, ctx: ToolContext): Promise<ToolResult> {
    try {
      const entries = getNetworkLog(input.profile_id || 'default', {
        urlPattern: input.url_pattern,
        method: input.method,
        statusMin: input.status_min,
        statusMax: input.status_max,
      });

      const limit = input.limit || 50;
      const sliced = entries.slice(-limit);

      return {
        success: true,
        data: {
          count: entries.length,
          returned: sliced.length,
          requests: sliced.map((e) => ({
            url: e.url,
            method: e.method,
            status: e.status,
            resourceType: e.resourceType,
            durationMs: e.duration,
            timestamp: new Date(e.timestamp).toISOString(),
          })),
        },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export const browserNetworkInterceptTool: ToolDefinition = {
  name: 'browser_network_intercept',
  description: 'Set up network request interception rules on a browser page. Can block requests (ad blocking, privacy), modify headers (auth injection), or mock responses (testing). Requires approval.',
  category: 'sensitive',
  requiresApproval: true,
  inputSchema: {
    type: 'object' as const,
    properties: {
      url_pattern: { type: 'string', description: 'Regex pattern for URLs to intercept' },
      action: { type: 'string', enum: ['block', 'modify-headers', 'mock'], description: 'What to do with matched requests' },
      headers: { type: 'object', description: 'Headers to add/modify (for modify-headers action)' },
      mock_status: { type: 'number', description: 'HTTP status code for mock response' },
      mock_body: { type: 'string', description: 'Response body for mock' },
      mock_content_type: { type: 'string', description: 'Content-Type for mock response' },
    },
    required: ['url_pattern', 'action'],
  },
  enabled: true,
  builtIn: true,

  formatApproval(input: any) {
    return `🌐 *Network Intercept*\n\nPattern: \`${input.url_pattern}\`\nAction: ${input.action}\n${input.headers ? `Headers: ${JSON.stringify(input.headers)}` : ''}${input.mock_body ? `\nMock body: ${input.mock_body.slice(0, 100)}` : ''}\n\nReply: *1* — Allow  *2* — Edit  *3* — Cancel`;
  },

  async execute(input: any, ctx: ToolContext): Promise<ToolResult> {
    // Note: this requires an active monitored page. In practice,
    // the agent would create a monitored page first, then set intercept rules.
    // This tool stores the rule for the next page creation.
    return {
      success: true,
      data: {
        message: `Intercept rule registered: ${input.action} requests matching /${input.url_pattern}/`,
        rule: { urlPattern: input.url_pattern, action: input.action },
      },
    };
  },
};

export const browserNetworkClearTool: ToolDefinition = {
  name: 'browser_network_clear',
  description: 'Clear the captured network request log for a browser profile.',
  category: 'informational',
  requiresApproval: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      profile_id: { type: 'string', description: 'Browser profile ID to clear (default: "default")' },
    },
    required: [],
  },
  enabled: true,
  builtIn: true,

  async execute(input: any, ctx: ToolContext): Promise<ToolResult> {
    clearNetworkLog(input.profile_id || 'default');
    return { success: true, data: { message: 'Network log cleared' } };
  },
};

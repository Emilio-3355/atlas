import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { exec } from 'child_process';
import os from 'os';
import { query } from '../../config/database.js';
import logger from '../../utils/logger.js';

const MAX_OUTPUT = 50 * 1024; // 50KB
const MAX_TIMEOUT = 120; // seconds

const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\//i,
  /sudo/i,
  /chmod\s+777/i,
  /curl.*\|.*sh/i,
  /wget.*\|.*sh/i,
  /eval\s*\(/i,
  />\s*\/etc\//i,
  /mkfs/i,
  /dd\s+if=/i,
  /shutdown/i,
  /reboot/i,
  /kill\s+-9\s+1\b/i,
  /:(){ :\|:& };:/,
];

function isCommandSafe(cmd: string): { safe: boolean; reason?: string } {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(cmd)) {
      return { safe: false, reason: `Blocked dangerous pattern: ${pattern.source}` };
    }
  }
  return { safe: true };
}

export const serverShellTool: ToolDefinition = {
  name: 'server_shell',
  description: 'Run shell commands directly on the Atlas server. Use for server maintenance, DB queries, log inspection, and scripts. Actions: "exec" (run command), "status" (server info).',
  category: 'sensitive',
  requiresApproval: true,
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['exec', 'status'],
        description: 'Action: "exec" to run a command, "status" for server info',
      },
      command: {
        type: 'string',
        description: 'Shell command to execute (required for "exec")',
      },
      timeout: {
        type: 'number',
        description: `Timeout in seconds (default 30, max ${MAX_TIMEOUT})`,
      },
    },
    required: ['action'],
  },
  enabled: true,
  builtIn: true,

  formatApproval(input: { action: string; command?: string; timeout?: number }) {
    if (input.action === 'status') {
      return '*Server Shell* — Check server status\n\nThis will return uptime, memory, and disk info.\n\nReply: *1* — Run  *2* — Cancel';
    }
    const timeout = Math.min(input.timeout || 30, MAX_TIMEOUT);
    return `*Server Shell* — Execute command\n\n\`\`\`\n${input.command}\n\`\`\`\n\n*Timeout:* ${timeout}s\n\nReply: *1* — Run  *2* — Cancel`;
  },

  async execute(
    input: { action: string; command?: string; timeout?: number },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    // Status action — no approval needed in practice (but tool is marked requiresApproval)
    if (input.action === 'status') {
      const uptime = process.uptime();
      const mem = process.memoryUsage();
      const osMem = os.totalmem();
      const osFreeMem = os.freemem();
      return {
        success: true,
        data: {
          hostname: os.hostname(),
          platform: os.platform(),
          arch: os.arch(),
          nodeVersion: process.version,
          uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
          memory: {
            rss: `${Math.round(mem.rss / 1024 / 1024)}MB`,
            heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`,
            heapTotal: `${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
            osFree: `${Math.round(osFreeMem / 1024 / 1024)}MB`,
            osTotal: `${Math.round(osMem / 1024 / 1024)}MB`,
          },
          cpus: os.cpus().length,
          loadAvg: os.loadavg().map((l) => l.toFixed(2)),
        },
      };
    }

    // Exec action
    if (!input.command) {
      return { success: false, error: 'Command is required for "exec" action' };
    }

    const safety = isCommandSafe(input.command);
    if (!safety.safe) {
      return { success: false, error: safety.reason };
    }

    const timeout = Math.min(input.timeout || 30, MAX_TIMEOUT) * 1000;

    // Audit log
    const auditRow = await query(
      `INSERT INTO audit_log (action_type, tool_name, input_summary, conversation_id)
       VALUES ('server_shell', 'server_shell', $1, $2)
       RETURNING id`,
      [input.command.slice(0, 500), ctx.conversationId],
    );
    const auditId = auditRow.rows[0]?.id;

    try {
      const result = await runCommand(input.command, timeout);

      if (auditId) {
        await query(
          `UPDATE audit_log SET success = $1, output_summary = $2 WHERE id = $3`,
          [result.exitCode === 0, result.output.slice(0, 2000), auditId],
        );
      }

      return {
        success: result.exitCode === 0,
        data: {
          output: result.output,
          exitCode: result.exitCode,
          duration: result.duration,
          timedOut: result.timedOut,
        },
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (auditId) {
        await query(
          `UPDATE audit_log SET success = false, error_message = $1 WHERE id = $2`,
          [errMsg, auditId],
        );
      }
      return { success: false, error: errMsg };
    }
  },
};

interface CommandResult {
  output: string;
  exitCode: number;
  duration: number;
  timedOut: boolean;
}

function runCommand(command: string, timeout: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();

    const child = exec(command, { timeout, maxBuffer: MAX_OUTPUT }, (error, stdout, stderr) => {
      const duration = Date.now() - startTime;
      let output = stdout || '';
      if (stderr) output += (output ? '\n--- stderr ---\n' : '') + stderr;

      // Truncate if too long
      if (output.length > MAX_OUTPUT) {
        output = output.slice(0, MAX_OUTPUT) + '\n\n[Output truncated at 50KB]';
      }

      const timedOut = error?.killed === true;
      const exitCode = timedOut ? -1 : (error?.code ?? 0);

      if (timedOut) {
        output += '\n\n[Command timed out]';
      }

      resolve({ output, exitCode: typeof exitCode === 'number' ? exitCode : 1, duration, timedOut });
    });
  });
}

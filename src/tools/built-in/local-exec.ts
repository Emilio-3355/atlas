import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { isDaemonOnline, getDaemonInfo, sendCommand } from '../../services/daemon-bridge.js';
import { query } from '../../config/database.js';
import logger from '../../utils/logger.js';

const MAX_SHELL_TIMEOUT = 120; // seconds
const MAX_CLAUDE_TIMEOUT = 300; // seconds

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
  /format\s+c:/i,
  /DROP\s+TABLE/i,
  /DELETE\s+FROM/i,
];

// Allowed base directories for claude_code action
const ALLOWED_BASES = [
  '/Users/juanpabloperalta',
  '/home/ubuntu',
];

function isCommandSafe(cmd: string): { safe: boolean; reason?: string } {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(cmd)) {
      return { safe: false, reason: `Blocked dangerous pattern: ${pattern.source}` };
    }
  }
  return { safe: true };
}

function isPathAllowed(targetPath: string): boolean {
  return ALLOWED_BASES.some((base) => targetPath.startsWith(base));
}

export const localExecTool: ToolDefinition = {
  name: 'local_exec',
  description: 'Run commands on JP\'s Mac remotely via the daemon. Actions: "status" (check if Mac is online), "shell" (run terminal command), "claude_code" (spawn Claude Code on a project).',
  category: 'sensitive',
  requiresApproval: true,
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'shell', 'claude_code'],
        description: 'Action: "status" (no approval), "shell" (run command), "claude_code" (spawn Claude Code)',
      },
      command: {
        type: 'string',
        description: 'Shell command to run (required for "shell" action)',
      },
      prompt: {
        type: 'string',
        description: 'Task prompt for Claude Code (required for "claude_code" action)',
      },
      directory: {
        type: 'string',
        description: 'Working directory on the Mac (required for "claude_code", optional for "shell")',
      },
      timeout: {
        type: 'number',
        description: `Timeout in seconds (shell: max ${MAX_SHELL_TIMEOUT}, claude_code: max ${MAX_CLAUDE_TIMEOUT})`,
      },
    },
    required: ['action'],
  },
  enabled: true,
  builtIn: true,

  formatApproval(input: { action: string; command?: string; prompt?: string; directory?: string; timeout?: number }) {
    if (input.action === 'status') {
      return '*Local Exec* — Check if Mac is online\n\nReply: *1* — Check  *2* — Cancel';
    }

    if (input.action === 'shell') {
      const timeout = Math.min(input.timeout || 30, MAX_SHELL_TIMEOUT);
      return `*Local Exec* — Run on Mac\n\n\`\`\`\n${input.command}\n\`\`\`\n${input.directory ? `*Dir:* ${input.directory}\n` : ''}*Timeout:* ${timeout}s\n\nReply: *1* — Run  *2* — Cancel`;
    }

    if (input.action === 'claude_code') {
      const timeout = Math.min(input.timeout || 300, MAX_CLAUDE_TIMEOUT);
      return `*Local Exec* — Claude Code on Mac\n\n*Project:* ${input.directory || '(home)'}\n*Task:* ${input.prompt}\n*Timeout:* ${timeout}s\n\nReply: *1* — Launch  *2* — Cancel`;
    }

    return '*Local Exec* — Unknown action';
  },

  async execute(
    input: { action: string; command?: string; prompt?: string; directory?: string; timeout?: number },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    // --- Status ---
    if (input.action === 'status') {
      const online = isDaemonOnline();
      const info = getDaemonInfo();
      return {
        success: true,
        data: {
          online,
          ...(info
            ? {
                hostname: info.hostname,
                platform: info.platform,
                connectedSince: info.connectedAt.toISOString(),
                lastHeartbeat: info.lastHeartbeat.toISOString(),
              }
            : {}),
        },
      };
    }

    // --- Shell ---
    if (input.action === 'shell') {
      if (!input.command) {
        return { success: false, error: 'Command is required for "shell" action' };
      }

      if (!isDaemonOnline()) {
        return { success: false, error: 'Mac is offline. Start the daemon first.' };
      }

      const safety = isCommandSafe(input.command);
      if (!safety.safe) {
        return { success: false, error: safety.reason };
      }

      const timeout = Math.min(input.timeout || 30, MAX_SHELL_TIMEOUT);

      // Log to daemon_commands
      const cmdId = crypto.randomUUID();
      await query(
        `INSERT INTO daemon_commands (command_id, daemon_id, action, command_text, directory, status, conversation_id)
         VALUES ($1, $2, $3, $4, $5, 'executing', $6)`,
        [cmdId, getDaemonInfo()?.daemonId || 'unknown', 'shell', input.command, input.directory || null, ctx.conversationId],
      );

      try {
        const result = await sendCommand({
          action: 'shell',
          command: input.command,
          directory: input.directory,
          timeout,
        });

        // Update DB
        await query(
          `UPDATE daemon_commands SET status = $1, output = $2, exit_code = $3, duration_ms = $4, completed_at = NOW()
           WHERE command_id = $5`,
          [result.success ? 'completed' : 'failed', result.output.slice(0, 10000), result.exitCode, result.duration, cmdId],
        );

        // Audit log
        await query(
          `INSERT INTO audit_log (action_type, tool_name, input_summary, success, output_summary, conversation_id)
           VALUES ('local_exec_shell', 'local_exec', $1, $2, $3, $4)`,
          [input.command.slice(0, 500), result.success, result.output.slice(0, 2000), ctx.conversationId],
        );

        return {
          success: result.success,
          data: {
            output: result.output,
            exitCode: result.exitCode,
            duration: result.duration,
          },
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await query(
          `UPDATE daemon_commands SET status = 'failed', output = $1, completed_at = NOW() WHERE command_id = $2`,
          [errMsg, cmdId],
        );
        return { success: false, error: errMsg };
      }
    }

    // --- Claude Code ---
    if (input.action === 'claude_code') {
      if (!input.prompt) {
        return { success: false, error: 'Prompt is required for "claude_code" action' };
      }

      if (!isDaemonOnline()) {
        return { success: false, error: 'Mac is offline. Start the daemon first.' };
      }

      // Validate directory if provided
      if (input.directory && !isPathAllowed(input.directory)) {
        return { success: false, error: `Path not allowed: ${input.directory}. Must be under an allowed base directory.` };
      }

      const timeout = Math.min(input.timeout || 300, MAX_CLAUDE_TIMEOUT);

      // Log to daemon_commands
      const cmdId = crypto.randomUUID();
      await query(
        `INSERT INTO daemon_commands (command_id, daemon_id, action, command_text, directory, status, conversation_id)
         VALUES ($1, $2, $3, $4, $5, 'executing', $6)`,
        [cmdId, getDaemonInfo()?.daemonId || 'unknown', 'claude_code', input.prompt.slice(0, 1000), input.directory || null, ctx.conversationId],
      );

      try {
        const result = await sendCommand({
          action: 'claude_code',
          prompt: input.prompt,
          directory: input.directory,
          timeout,
        });

        await query(
          `UPDATE daemon_commands SET status = $1, output = $2, exit_code = $3, duration_ms = $4, completed_at = NOW()
           WHERE command_id = $5`,
          [result.success ? 'completed' : 'failed', result.output.slice(0, 10000), result.exitCode, result.duration, cmdId],
        );

        await query(
          `INSERT INTO audit_log (action_type, tool_name, input_summary, success, output_summary, conversation_id)
           VALUES ('local_exec_claude', 'local_exec', $1, $2, $3, $4)`,
          [input.prompt.slice(0, 500), result.success, result.output.slice(0, 2000), ctx.conversationId],
        );

        return {
          success: result.success,
          data: {
            output: result.output,
            exitCode: result.exitCode,
            duration: result.duration,
            project: input.directory,
          },
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await query(
          `UPDATE daemon_commands SET status = 'failed', output = $1, completed_at = NOW() WHERE command_id = $2`,
          [errMsg, cmdId],
        );
        return { success: false, error: errMsg };
      }
    }

    return { success: false, error: `Unknown action: ${input.action}` };
  },
};

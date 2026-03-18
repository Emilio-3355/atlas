import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { query } from '../../config/database.js';
import logger from '../../utils/logger.js';

// Allowed base directories (whitelist — never allow arbitrary paths)
const ALLOWED_BASES = [
  '/Users/juanpabloperalta',
  '/home/ubuntu',
];

function isPathAllowed(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  return ALLOWED_BASES.some((base) => resolved.startsWith(base));
}

// Dangerous patterns that should never appear in agent tasks
const BLOCKED_PATTERNS = [
  /rm\s+-rf/i,
  /sudo/i,
  /chmod\s+777/i,
  /curl.*\|.*sh/i,
  /wget.*\|.*sh/i,
  /eval\s*\(/i,
  /> \/etc\//i,
  /DROP\s+TABLE/i,
  /DELETE\s+FROM/i,
  /format\s+c:/i,
];

function isTaskSafe(task: string): { safe: boolean; reason?: string } {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(task)) {
      return { safe: false, reason: `Blocked dangerous pattern: ${pattern.source}` };
    }
  }
  return { safe: true };
}

export const spawnAgentTool: ToolDefinition = {
  name: 'spawn_agent',
  description: 'Mobile Command Center: spawn a coding agent in a project directory to build features, fix bugs, or run tasks. JP can drop a message while walking and Atlas handles the rest. Shows preview + requires approval before executing.',
  category: 'sensitive',
  requiresApproval: true,
  inputSchema: {
    type: 'object' as const,
    properties: {
      project: {
        type: 'string',
        description: 'Project directory path (e.g., "/Users/juanpabloperalta/atlas" or just "atlas")',
      },
      task: {
        type: 'string',
        description: 'What to build/fix/do — natural language description of the task',
      },
      mode: {
        type: 'string',
        enum: ['build', 'fix', 'review', 'test', 'explore', 'atlas_sub'],
        description: 'Agent mode: build (new features), fix (bugs), review (code review), test (run tests), explore (understand codebase)',
      },
      timeout: {
        type: 'number',
        description: 'Max execution time in seconds (default 300, max 600)',
      },
      parallel_tasks: {
        type: 'array',
        items: { type: 'string' },
        description: 'For atlas_sub mode: list of tasks to run in parallel (max 3)',
      },
    },
    required: ['project', 'task'],
  },
  enabled: true,
  builtIn: true,

  formatApproval(input: { project: string; task: string; mode?: string; timeout?: number }) {
    const mode = input.mode || 'build';
    const timeout = Math.min(input.timeout || 300, 600);
    return `🤖 *Mobile Command Center*\n\nI'd like to spawn a coding agent:\n\n*Project:* ${input.project}\n*Task:* ${input.task}\n*Mode:* ${mode}\n*Timeout:* ${timeout}s\n\nThe agent will work in a sandboxed environment. I'll send you updates as it progresses.\n\nReply: *1* — Launch  *2* — Edit  *3* — Cancel`;
  },

  async execute(
    input: { project: string; task: string; mode?: string; timeout?: number; parallel_tasks?: string[] },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const mode = input.mode || 'build';
    const timeout = Math.min(input.timeout || 300, 600) * 1000;

    // Atlas sub-agent mode: runs as a lightweight internal agent
    if (mode === 'atlas_sub') {
      const { runSubAgent, runParallelSubAgents } = await import('../../agent/sub-agent.js');

      // Parallel mode
      if (input.parallel_tasks && input.parallel_tasks.length > 1) {
        const tasks = input.parallel_tasks.map((t: string) => ({ task: t, depth: 'fast' as const }));
        const results = await runParallelSubAgents(tasks, ctx);
        return {
          success: results.every(r => r.success),
          data: {
            results: results.map((r, i) => ({
              task: input.parallel_tasks![i],
              output: r.output,
              toolsUsed: r.toolsUsed,
              success: r.success,
            })),
            mode: 'atlas_sub_parallel',
          },
        };
      }

      // Single sub-agent
      const result = await runSubAgent({ task: input.task, depth: 'fast' }, ctx);
      return {
        success: result.success,
        data: {
          output: result.output,
          toolsUsed: result.toolsUsed,
          iterations: result.iterations,
          durationMs: result.durationMs,
          mode: 'atlas_sub',
        },
      };
    }

    // Resolve project path
    let projectPath = input.project;
    if (!path.isAbsolute(projectPath)) {
      // Try common bases
      const candidates = [
        path.join('/Users/juanpabloperalta', projectPath),
        path.join('/Users/juanpabloperalta/Desktop', projectPath),
        path.join('/home/ubuntu', projectPath),
      ];
      projectPath = candidates.find((p) => fs.existsSync(p)) || projectPath;
    }

    // Security: validate path
    if (!isPathAllowed(projectPath)) {
      return { success: false, error: `Path not allowed: ${projectPath}. Must be under an allowed base directory.` };
    }

    if (!fs.existsSync(projectPath)) {
      return { success: false, error: `Project directory not found: ${projectPath}` };
    }

    // Security: validate task
    const safety = isTaskSafe(input.task);
    if (!safety.safe) {
      return { success: false, error: safety.reason };
    }

    // Build the agent prompt based on mode
    const agentPrompt = buildAgentPrompt(mode, input.task, projectPath);

    // Record the agent spawn
    const agentRecord = await query(
      `INSERT INTO audit_log (action_type, tool_name, input_summary, conversation_id)
       VALUES ('agent_spawn', 'spawn_agent', $1, $2)
       RETURNING id`,
      [JSON.stringify({ project: projectPath, task: input.task, mode }), ctx.conversationId]
    );

    try {
      // Spawn claude CLI as a subprocess
      const result = await runAgent(projectPath, agentPrompt, timeout);

      // Update audit log
      await query(
        `UPDATE audit_log SET success = $1, output_summary = $2 WHERE id = $3`,
        [result.success, result.output.slice(0, 2000), agentRecord.rows[0].id]
      );

      return {
        success: result.success,
        data: {
          output: result.output,
          filesChanged: result.filesChanged,
          duration: result.duration,
          project: projectPath,
          mode,
        },
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await query(
        `UPDATE audit_log SET success = false, error_message = $1 WHERE id = $2`,
        [errMsg, agentRecord.rows[0].id]
      );
      return { success: false, error: errMsg };
    }
  },
};

function buildAgentPrompt(mode: string, task: string, projectPath: string): string {
  const modeInstructions: Record<string, string> = {
    build: `You are a coding agent. Build the following feature in the project at ${projectPath}:\n\n${task}\n\nWrite clean, production-quality code. Follow existing patterns and conventions. Do not break existing functionality.`,
    fix: `You are a debugging agent. Fix the following issue in the project at ${projectPath}:\n\n${task}\n\nIdentify the root cause, fix it, and verify the fix doesn't break anything else.`,
    review: `You are a code review agent. Review the codebase at ${projectPath} for:\n\n${task}\n\nProvide specific, actionable feedback. List files, line numbers, and suggested changes.`,
    test: `You are a testing agent. For the project at ${projectPath}:\n\n${task}\n\nRun the tests and report results. If tests fail, analyze why.`,
    explore: `You are a codebase exploration agent. For the project at ${projectPath}:\n\n${task}\n\nNavigate the codebase and provide a detailed answer. Cite specific files and line numbers.`,
  };

  return modeInstructions[mode] || modeInstructions.build;
}

interface AgentResult {
  success: boolean;
  output: string;
  filesChanged: string[];
  duration: number;
}

function runAgent(projectPath: string, prompt: string, timeout: number): Promise<AgentResult> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let output = '';
    let timedOut = false;

    // Use claude CLI with --print flag for non-interactive mode
    const agent = spawn('claude', ['-p', prompt, '--output-format', 'text'], {
      cwd: projectPath,
      timeout,
      env: {
        ...process.env,
        CLAUDE_CODE_ENTRYPOINT: 'atlas-agent',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    agent.stdout.on('data', (data: Buffer) => {
      output += data.toString();
    });

    agent.stderr.on('data', (data: Buffer) => {
      output += data.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      agent.kill('SIGTERM');
    }, timeout);

    agent.on('close', (code) => {
      clearTimeout(timer);
      const duration = Date.now() - startTime;

      // Try to detect files changed from output
      const filePatterns = output.match(/(?:Created|Modified|Edited|Wrote)\s+(?:file\s+)?([^\s]+\.\w+)/gi) || [];
      const filesChanged = filePatterns.map((m) => m.replace(/^(Created|Modified|Edited|Wrote)\s+(file\s+)?/i, ''));

      if (timedOut) {
        resolve({
          success: false,
          output: output + '\n\n[Agent timed out]',
          filesChanged,
          duration,
        });
      } else {
        resolve({
          success: code === 0,
          output: output || '(no output)',
          filesChanged,
          duration,
        });
      }
    });

    agent.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

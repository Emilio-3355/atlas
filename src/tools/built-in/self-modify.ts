import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { isDaemonOnline, sendCommand } from '../../services/daemon-bridge.js';
import { query } from '../../config/database.js';
import logger from '../../utils/logger.js';

const ATLAS_DIR = '/Users/juanpabloperalta/atlas';
const MAX_TIMEOUT = 600; // 10 min for complex features

// Files that must NEVER be modified by self-evolution
const PROTECTED_PATHS = [
  'src/security/',
  'src/config/env.ts',
  'src/services/daemon-bridge.ts',
  '.env',
  'railway.toml',
  'Dockerfile',
];

export const selfModifyTool: ToolDefinition = {
  name: 'self_modify',
  description: 'Self-evolution: plan, implement, and deploy new Atlas capabilities. Use when JP says "add yourself the ability to...", "I want you to be able to...", "build yourself a...". Three phases: plan → implement → deploy. Each requires JP approval.',
  category: 'sensitive',
  requiresApproval: true,
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['plan', 'implement', 'deploy'],
        description: 'Phase: "plan" (analyze & design), "implement" (code via Claude Code), "deploy" (commit, push, verify)',
      },
      description: {
        type: 'string',
        description: 'What capability to add/modify (required for "plan")',
      },
      plan: {
        type: 'string',
        description: 'The approved plan from phase 1 (required for "implement")',
      },
      commit_message: {
        type: 'string',
        description: 'Commit message (required for "deploy")',
      },
    },
    required: ['action'],
  },
  enabled: true,
  builtIn: true,

  formatApproval(input: { action: string; description?: string; plan?: string; commit_message?: string }) {
    if (input.action === 'plan') {
      return `🧬 *Self-Evolution — Plan*\n\nI'll analyze the Atlas codebase and design an implementation plan for:\n\n*"${input.description}"*\n\nThis is read-only — no code changes yet.\n\nReply: *1* — Plan it  *3* — Cancel`;
    }
    if (input.action === 'implement') {
      return `🧬 *Self-Evolution — Implement*\n\nI'll spawn Claude Code on the Atlas codebase to implement the approved plan. Changes will be made locally (not deployed yet).\n\n*Plan:*\n${(input.plan || '').slice(0, 800)}\n\nReply: *1* — Build it  *3* — Cancel`;
    }
    if (input.action === 'deploy') {
      return `🧬 *Self-Evolution — Deploy*\n\nI'll commit, push, and deploy the changes to Railway.\n\n*Commit:* ${input.commit_message}\n\nReply: *1* — Deploy  *3* — Cancel`;
    }
    return '🧬 *Self-Evolution* — Unknown action';
  },

  async execute(input: { action: string; description?: string; plan?: string; commit_message?: string }, ctx: ToolContext): Promise<ToolResult> {
    if (!isDaemonOnline()) {
      return { success: false, error: 'Mac daemon is offline. Self-modification requires the daemon to be running on your Mac.' };
    }

    // Audit every self-modification action
    await query(
      `INSERT INTO audit_log (action_type, tool_name, input_summary, conversation_id)
       VALUES ($1, 'self_modify', $2, $3)`,
      [`self_modify_${input.action}`, JSON.stringify(input).slice(0, 2000), ctx.conversationId],
    ).catch(() => {});

    if (input.action === 'plan') return planPhase(input.description || '', ctx);
    if (input.action === 'implement') return implementPhase(input.plan || '', ctx);
    if (input.action === 'deploy') return deployPhase(input.commit_message || 'feat: self-evolved capability', ctx);

    return { success: false, error: `Unknown action: ${input.action}` };
  },
};

// ─── Phase 1: Plan ───────────────────────────────────────────────

async function planPhase(description: string, ctx: ToolContext): Promise<ToolResult> {
  if (!description.trim()) {
    return { success: false, error: 'Description is required for planning.' };
  }

  const prompt = `You are analyzing the Atlas AI assistant codebase to plan a new capability.

REQUESTED CAPABILITY: "${description}"

INSTRUCTIONS:
1. Read the project structure: list key directories under src/
2. Read src/tools/registry.ts to understand how tools are registered
3. Read src/types/index.ts for ToolDefinition interface
4. Read 1-2 existing tools in src/tools/built-in/ as reference for patterns
5. Check if this capability already partially exists

Then produce a PLAN with:
- APPROACH: 1-2 sentences on strategy (new tool vs modify existing vs multi-file)
- FILES: list of files to create or modify with brief description of changes
- IMPLEMENTATION: key design decisions, data structures, APIs needed
- RISK: what could break, and how to mitigate
- COMPLEXITY: simple (1 file) / medium (2-3 files) / complex (4+ files)

CONSTRAINTS:
- Follow existing patterns (ToolDefinition interface, registry registration)
- NEVER modify: ${PROTECTED_PATHS.join(', ')}
- Keep it minimal — smallest change that delivers the capability
- Must pass \`npm run build\` (TypeScript strict mode)

Output the plan as clear markdown.`;

  try {
    const result = await sendCommand({
      action: 'claude_code',
      prompt,
      directory: ATLAS_DIR,
      timeout: 120,
    });

    if (!result.success || !result.output?.trim()) {
      return { success: false, error: `Planning failed: ${result.output || 'empty response'}` };
    }

    return {
      success: true,
      data: {
        plan: result.output.trim(),
        description,
        phase: 'plan',
        nextStep: 'If JP approves, call self_modify with action="implement" and pass this plan.',
      },
    };
  } catch (err) {
    return { success: false, error: `Planning error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─── Phase 2: Implement ─────────────────────────────────────────

async function implementPhase(plan: string, ctx: ToolContext): Promise<ToolResult> {
  if (!plan.trim()) {
    return { success: false, error: 'Approved plan is required for implementation.' };
  }

  const prompt = `You are implementing a new capability for the Atlas AI assistant.

APPROVED PLAN:
${plan}

INSTRUCTIONS:
1. Implement exactly what the plan describes
2. Follow existing code patterns — read similar tools for reference
3. Register any new tools in src/tools/registry.ts (both sync and async functions)
4. After implementation, run: npm run build
5. If build fails, fix the errors and rebuild until it passes

CONSTRAINTS:
- NEVER modify these protected files: ${PROTECTED_PATHS.join(', ')}
- TypeScript strict mode — no 'any' where avoidable, proper types
- Export tool as: export const [name]Tool: ToolDefinition = { ... }
- Include inputSchema with proper JSON Schema
- Include formatApproval if requiresApproval is true
- Keep code concise — no unnecessary comments or over-engineering
- Must compile cleanly with npm run build

IMPORTANT: After all changes, run \`npm run build\` and report the result. If it fails, fix and retry.
Do NOT run git commands — deployment is handled separately.`;

  try {
    const result = await sendCommand({
      action: 'claude_code',
      prompt,
      directory: ATLAS_DIR,
      timeout: MAX_TIMEOUT,
    });

    if (!result.success) {
      return { success: false, error: `Implementation failed: ${result.output || 'unknown error'}` };
    }

    // Check if build passed by looking for success indicators in output
    const output = result.output || '';
    const buildFailed = /error TS\d+|Build failed|npm ERR!/i.test(output) && !/0 errors/i.test(output);

    // Get git diff to show what changed
    let diff = '';
    try {
      const diffResult = await sendCommand({
        action: 'shell',
        command: 'cd /Users/juanpabloperalta/atlas && git diff --stat && echo "---DIFF---" && git diff --name-only',
        timeout: 10,
      });
      diff = diffResult.output || '';
    } catch {
      // Non-critical
    }

    // Check for protected file modifications
    const changedFiles = diff.split('\n').filter(l => l.trim());
    const protectedViolations = changedFiles.filter(f =>
      PROTECTED_PATHS.some(p => f.includes(p))
    );

    if (protectedViolations.length > 0) {
      // Revert protected file changes
      for (const file of protectedViolations) {
        await sendCommand({
          action: 'shell',
          command: `cd /Users/juanpabloperalta/atlas && git checkout -- "${file}"`,
          timeout: 5,
        }).catch(() => {});
      }
      return {
        success: false,
        error: `Implementation tried to modify protected files: ${protectedViolations.join(', ')}. Changes to those files were reverted.`,
      };
    }

    return {
      success: true,
      data: {
        output: output.slice(-3000), // Last 3K chars (most relevant)
        diff,
        buildPassed: !buildFailed,
        phase: 'implement',
        nextStep: buildFailed
          ? 'Build failed. Review errors and retry, or abort.'
          : 'If JP approves the changes, call self_modify with action="deploy" to commit and push.',
      },
    };
  } catch (err) {
    return { success: false, error: `Implementation error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─── Phase 3: Deploy ────────────────────────────────────────────

async function deployPhase(commitMessage: string, ctx: ToolContext): Promise<ToolResult> {
  try {
    // 1. Verify build passes before deploying
    const buildResult = await sendCommand({
      action: 'shell',
      command: 'cd /Users/juanpabloperalta/atlas && npm run build 2>&1',
      timeout: 30,
    });

    if (!buildResult.success || /error TS\d+/i.test(buildResult.output)) {
      return { success: false, error: `Build failed — cannot deploy:\n${buildResult.output.slice(-1000)}` };
    }

    // 2. Get list of changed files for the commit
    const statusResult = await sendCommand({
      action: 'shell',
      command: 'cd /Users/juanpabloperalta/atlas && git diff --name-only',
      timeout: 5,
    });

    const changedFiles = (statusResult.output || '').trim().split('\n').filter(f => f.trim());
    if (changedFiles.length === 0) {
      // Check untracked files too
      const untrackedResult = await sendCommand({
        action: 'shell',
        command: 'cd /Users/juanpabloperalta/atlas && git ls-files --others --exclude-standard',
        timeout: 5,
      });
      const untracked = (untrackedResult.output || '').trim().split('\n').filter(f => f.trim());
      if (untracked.length === 0) {
        return { success: false, error: 'No changes to deploy.' };
      }
      changedFiles.push(...untracked);
    }

    // 3. Final protected file check
    const protectedViolations = changedFiles.filter(f =>
      PROTECTED_PATHS.some(p => f.includes(p))
    );
    if (protectedViolations.length > 0) {
      return { success: false, error: `Cannot deploy — protected files were modified: ${protectedViolations.join(', ')}` };
    }

    // 4. Stage, commit, push
    const fileList = changedFiles.map(f => `"${f}"`).join(' ');
    const safeMsg = commitMessage.replace(/"/g, '\\"').replace(/`/g, '\\`');

    const deployResult = await sendCommand({
      action: 'shell',
      command: `cd /Users/juanpabloperalta/atlas && git add ${fileList} && git commit -m "${safeMsg}" && git push origin main 2>&1`,
      timeout: 30,
    });

    if (!deployResult.success) {
      return { success: false, error: `Deploy failed:\n${deployResult.output}` };
    }

    // 5. Extract commit hash
    const hashMatch = deployResult.output.match(/\[main\s+([a-f0-9]+)\]/);
    const commitHash = hashMatch ? hashMatch[1] : 'unknown';

    // 6. Log successful evolution
    await query(
      `INSERT INTO audit_log (action_type, tool_name, input_summary, success, output_summary, conversation_id)
       VALUES ('self_evolution_deployed', 'self_modify', $1, true, $2, $3)`,
      [
        JSON.stringify({ commitMessage: safeMsg, files: changedFiles }),
        `Deployed commit ${commitHash}: ${changedFiles.length} files changed`,
        ctx.conversationId,
      ],
    ).catch(() => {});

    return {
      success: true,
      data: {
        commitHash,
        filesDeployed: changedFiles,
        message: commitMessage,
        phase: 'deploy',
        note: 'Railway will auto-deploy. New capability will be live in ~2 minutes.',
      },
    };
  } catch (err) {
    return { success: false, error: `Deploy error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

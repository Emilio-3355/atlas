import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { callClaude, extractTextContent } from '../../agent/claude-client.js';
import { getToolRegistry } from '../registry.js';
import { query } from '../../config/database.js';
import Anthropic from '@anthropic-ai/sdk';
import logger from '../../utils/logger.js';

export const codeForgeTool: ToolDefinition = {
  name: 'code_forge',
  description: 'Self-improvement engine: generate, validate, and dynamically register a new tool from a natural language description. Atlas proposes the tool, generates TypeScript code, validates it, and registers it — all with JP\'s approval.',
  category: 'sensitive',
  requiresApproval: true,
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Tool name (snake_case)' },
      description: { type: 'string', description: 'What the tool should do' },
      rationale: { type: 'string', description: 'Why this tool is needed (cite usage patterns)' },
      category: { type: 'string', enum: ['informational', 'action', 'sensitive'], description: 'Tool category' },
      requiresApproval: { type: 'boolean', description: 'Whether the tool needs JP approval to execute' },
      examples: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'Example input' },
            output: { type: 'string', description: 'Expected output' },
          },
        },
        description: 'Example input/output pairs to guide code generation',
      },
    },
    required: ['name', 'description', 'rationale', 'category'],
  },
  enabled: true,
  builtIn: true,

  formatApproval(input: { name: string; description: string; rationale: string; category: string; requiresApproval?: boolean }) {
    return `🔨 *Code Forge — New Tool Proposal*\n\n*Name:* ${input.name}\n*Description:* ${input.description}\n*Why:* ${input.rationale}\n*Category:* ${input.category}\n*Needs approval:* ${input.requiresApproval !== false ? 'Yes' : 'No'}\n\nI'll generate the code, validate it, and register it dynamically.\n\nReply: *1* — Forge it  *2* — Edit spec  *3* — Cancel`;
  },

  async execute(
    input: {
      name: string;
      description: string;
      rationale: string;
      category: string;
      requiresApproval?: boolean;
      examples?: Array<{ input: string; output: string }>;
    },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    try {
      // Step 1: Generate tool code with Claude
      const generatedCode = await generateToolCode(input);

      if (!generatedCode) {
        return { success: false, error: 'Failed to generate tool code' };
      }

      // Step 2: Validate the generated code
      const validation = validateToolCode(generatedCode, input.name);
      if (!validation.valid) {
        // Try once more with the error feedback
        const retryCode = await generateToolCode(input, validation.errors);
        if (!retryCode) {
          return { success: false, error: `Code validation failed: ${validation.errors.join(', ')}` };
        }
        const retryValidation = validateToolCode(retryCode, input.name);
        if (!retryValidation.valid) {
          return { success: false, error: `Code validation failed after retry: ${retryValidation.errors.join(', ')}` };
        }
        // Use the retry code
        return await registerDynamicTool(retryCode, input, ctx);
      }

      // Step 3: Register the tool dynamically
      return await registerDynamicTool(generatedCode, input, ctx);
    } catch (err) {
      logger.error('Code forge error', { error: err, tool: input.name });
      return { success: false, error: err instanceof Error ? err.message : 'Code forge failed' };
    }
  },
};

async function generateToolCode(
  spec: { name: string; description: string; category: string; requiresApproval?: boolean; examples?: Array<{ input: string; output: string }> },
  previousErrors?: string[],
): Promise<string | null> {
  const errorContext = previousErrors
    ? `\n\nThe previous attempt had these errors — fix them:\n${previousErrors.join('\n')}`
    : '';

  const examplesContext = spec.examples
    ? `\n\nExamples:\n${spec.examples.map((e) => `Input: ${e.input}\nExpected output: ${e.output}`).join('\n\n')}`
    : '';

  const prompt = `Generate a TypeScript tool implementation for an Atlas agent tool.

The tool must export a single object that conforms to this interface:
\`\`\`typescript
interface ToolDefinition {
  name: string;
  description: string;
  category: 'informational' | 'action' | 'sensitive';
  requiresApproval: boolean;
  inputSchema: { type: 'object'; properties: Record<string, any>; required: string[] };
  enabled: boolean;
  builtIn: boolean;
  execute: (input: any, ctx: { conversationId: string; userPhone: string; language: string }) => Promise<{ success: boolean; data?: any; error?: string }>;
  formatApproval?: (input: any) => string;
}
\`\`\`

Tool specification:
- Name: ${spec.name}
- Description: ${spec.description}
- Category: ${spec.category}
- Requires approval: ${spec.requiresApproval !== false}
${examplesContext}${errorContext}

RULES:
1. Export the tool as: export const tool = { ... }
2. The execute function must be async and return { success, data?, error? }
3. Use only built-in Node.js modules or fetch() — no external imports
4. Never use eval(), Function(), or child_process
5. Never access environment variables directly
6. Keep the implementation simple and focused
7. Include proper error handling with try/catch

Return ONLY the TypeScript code, no markdown fences, no explanation.`;

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: prompt }];

  const response = await callClaude({
    messages,
    system: 'You are a TypeScript code generator. Return ONLY valid TypeScript code. No markdown, no explanations.',
    depth: 'deep',
    maxTokens: 2000,
  });

  const code = extractTextContent(response.content).trim();

  // Strip markdown fences if present
  const cleaned = code
    .replace(/^```(?:typescript|ts)?\n?/gm, '')
    .replace(/```$/gm, '')
    .trim();

  return cleaned || null;
}

function validateToolCode(code: string, expectedName: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Security checks
  if (/\beval\b/.test(code)) errors.push('eval() is not allowed');
  if (/\bFunction\b\s*\(/.test(code)) errors.push('Function() constructor is not allowed');
  if (/child_process/.test(code)) errors.push('child_process is not allowed');
  if (/process\.env/.test(code)) errors.push('Direct env access is not allowed');
  if (/require\s*\(/.test(code)) errors.push('require() is not allowed — use imports');
  if (/fs\.(write|unlink|rm|mkdir)/.test(code)) errors.push('Filesystem writes are not allowed');
  if (/\bexec\b|\bspawn\b/.test(code)) errors.push('Process execution is not allowed');

  // Structure checks
  if (!code.includes('export const tool')) errors.push('Must export as: export const tool = { ... }');
  if (!code.includes('execute')) errors.push('Must have an execute function');
  if (!code.includes('inputSchema')) errors.push('Must have an inputSchema');
  if (!code.includes(expectedName)) errors.push(`Tool name should be "${expectedName}"`);

  return { valid: errors.length === 0, errors };
}

async function registerDynamicTool(
  code: string,
  spec: { name: string; description: string; rationale: string; category: string; requiresApproval?: boolean },
  ctx: ToolContext,
): Promise<ToolResult> {
  // Store in database
  await query(
    `INSERT INTO tool_definitions (name, description, input_schema, implementation_type, implementation, rationale, status)
     VALUES ($1, $2, '{}', 'generated_code', $3, $4, 'active')
     ON CONFLICT (name) DO UPDATE SET
       description = $2, implementation = $3, rationale = $4, status = 'active', approved_at = NOW()`,
    [spec.name, spec.description, JSON.stringify({ code }), spec.rationale]
  );

  // Dynamically compile and register the tool
  try {
    // Use dynamic import with data URL to load the generated code
    // This is sandboxed — the code can't access the filesystem or spawn processes
    const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
    const module = await import(dataUrl);
    const tool = module.tool as ToolDefinition;

    if (tool && tool.name && typeof tool.execute === 'function') {
      const registry = getToolRegistry();
      registry.register(tool);
      logger.info('Dynamic tool registered', { name: spec.name });

      return {
        success: true,
        data: {
          name: spec.name,
          message: `Tool "${spec.name}" forged and activated! It's now available for use.`,
          code: code.slice(0, 500) + (code.length > 500 ? '...' : ''),
        },
      };
    }

    return { success: false, error: 'Generated code did not export a valid tool object' };
  } catch (err) {
    // If dynamic loading fails, store it as proposed (needs manual review)
    await query(
      `UPDATE tool_definitions SET status = 'proposed' WHERE name = $1`,
      [spec.name]
    );

    return {
      success: false,
      error: `Tool code generated but failed to load dynamically: ${err instanceof Error ? err.message : String(err)}. Stored as proposed for manual review.`,
    };
  }
}

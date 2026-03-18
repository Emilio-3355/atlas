import { query } from '../config/database.js';
import { callClaude, extractTextContent } from '../agent/claude-client.js';
import { getToolRegistry } from '../tools/registry.js';
import { sendWhatsAppMessage } from '../services/whatsapp.js';
import { getEnv } from '../config/env.js';
import { dashboardBus } from '../services/dashboard-events.js';
import logger from '../utils/logger.js';
import crypto from 'crypto';

// ===== Types =====

interface WorkflowPattern {
  id: string;
  tool_sequence: string[];
  input_summary: string;
  output_summary: string;
  success: boolean;
  conversation_id: string;
  pattern_hash: string;
  crystallized: boolean;
  created_at: Date;
}

interface CrystallizationProposal {
  name: string;
  description: string;
  rationale: string;
  tool_sequence: string[];
  occurrence_count: number;
  success_rate: number;
}

// ===== Pattern Recording =====

/**
 * Record a completed tool chain from the ReAct loop.
 * Called from core.ts after a successful multi-tool conversation.
 */
export async function recordToolChain(
  toolSequence: string[],
  inputSummary: string,
  outputSummary: string,
  success: boolean,
  conversationId: string,
): Promise<void> {
  if (toolSequence.length < 2) return; // Only record multi-tool chains

  const patternHash = crypto
    .createHash('sha256')
    .update(toolSequence.sort().join('|'))
    .digest('hex')
    .slice(0, 16);

  try {
    await query(
      `INSERT INTO workflow_patterns (tool_sequence, input_summary, output_summary, success, conversation_id, pattern_hash)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [toolSequence, inputSummary.slice(0, 500), outputSummary.slice(0, 500), success, conversationId, patternHash]
    );
    logger.debug('Recorded tool chain', { tools: toolSequence, hash: patternHash });
  } catch (err) {
    logger.error('Failed to record tool chain', { error: err });
  }
}

// ===== Pattern Analysis =====

/**
 * Analyze recorded patterns and find candidates for crystallization.
 * A pattern qualifies when: count >= 3 AND success_rate >= 70%
 */
async function findCrystallizationCandidates(): Promise<CrystallizationProposal[]> {
  const result = await query(
    `SELECT
       pattern_hash,
       tool_sequence,
       COUNT(*) as occurrence_count,
       COUNT(*) FILTER (WHERE success = true) as success_count,
       ROUND(COUNT(*) FILTER (WHERE success = true)::numeric / COUNT(*)::numeric * 100, 1) as success_rate
     FROM workflow_patterns
     WHERE crystallized = false
       AND created_at > NOW() - INTERVAL '30 days'
     GROUP BY pattern_hash, tool_sequence
     HAVING COUNT(*) >= 3
       AND COUNT(*) FILTER (WHERE success = true)::numeric / COUNT(*)::numeric >= 0.7
     ORDER BY COUNT(*) DESC
     LIMIT 5`
  );

  if (result.rows.length === 0) return [];

  // For each qualifying pattern, get a representative input/output
  const candidates: CrystallizationProposal[] = [];

  for (const row of result.rows) {
    // Get the most recent successful example
    const example = await query(
      `SELECT input_summary, output_summary FROM workflow_patterns
       WHERE pattern_hash = $1 AND success = true
       ORDER BY created_at DESC LIMIT 1`,
      [row.pattern_hash]
    );

    const inputExample = example.rows[0]?.input_summary || '';
    const outputExample = example.rows[0]?.output_summary || '';

    // Ask Claude to design a crystallized tool
    const proposal = await designCrystallizedTool(
      row.tool_sequence,
      Number(row.occurrence_count),
      Number(row.success_rate),
      inputExample,
      outputExample,
    );

    if (proposal) {
      candidates.push(proposal);
    }
  }

  return candidates;
}

/**
 * Ask Claude to design a single tool that replaces a multi-tool chain.
 */
async function designCrystallizedTool(
  toolSequence: string[],
  occurrenceCount: number,
  successRate: number,
  inputExample: string,
  outputExample: string,
): Promise<CrystallizationProposal | null> {
  const registry = getToolRegistry();
  const toolDescriptions = toolSequence
    .map((name) => {
      const tool = registry.get(name);
      return tool ? `- ${name}: ${tool.description}` : `- ${name}: (unknown)`;
    })
    .join('\n');

  const prompt = `You are an AI tool designer. A multi-tool workflow has been used ${occurrenceCount} times with a ${successRate}% success rate. Design a single consolidated tool to replace it.

TOOL CHAIN:
${toolDescriptions}

SEQUENCE: ${toolSequence.join(' -> ')}

EXAMPLE INPUT: ${inputExample}
EXAMPLE OUTPUT: ${outputExample}

Design a new tool that combines this workflow into one step. Respond in this EXACT format:
NAME: snake_case_tool_name
DESCRIPTION: One-line description of what the tool does
RATIONALE: Why this crystallization is valuable (cite the usage count and success rate)

Rules:
- Name must be snake_case, max 30 chars
- Description must be clear and actionable
- Rationale must reference the pattern data`;

  try {
    const response = await callClaude({
      messages: [{ role: 'user', content: prompt }],
      system: 'You are a tool designer. Be concise and precise.',
      depth: 'fast',
      maxTokens: 300,
    });

    const text = extractTextContent(response.content);

    // Parse the response
    const nameMatch = text.match(/NAME:\s*(.+)/i);
    const descMatch = text.match(/DESCRIPTION:\s*(.+)/i);
    const rationaleMatch = text.match(/RATIONALE:\s*(.+)/i);

    if (!nameMatch || !descMatch || !rationaleMatch) return null;

    return {
      name: nameMatch[1].trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 30),
      description: descMatch[1].trim(),
      rationale: rationaleMatch[1].trim(),
      tool_sequence: toolSequence,
      occurrence_count: occurrenceCount,
      success_rate: successRate,
    };
  } catch (err) {
    logger.error('Failed to design crystallized tool', { error: err });
    return null;
  }
}

// ===== Crystallization Execution =====

/**
 * Run the foundry analysis. Called nightly and can be triggered manually.
 * Finds qualifying patterns, proposes crystallized tools, and notifies JP.
 */
export async function runFoundryAnalysis(): Promise<void> {
  logger.info('Foundry analysis started');
  dashboardBus.publish({ type: 'cron_fired', data: { job: 'Foundry Analysis' } });

  try {
    const candidates = await findCrystallizationCandidates();

    if (candidates.length === 0) {
      logger.info('Foundry: no crystallization candidates found');
      return;
    }

    // Notify JP about each candidate
    const phone = getEnv().JP_PHONE_NUMBER;

    let message = `*Foundry -- Tool Crystallization Proposals*\n\n`;
    message += `I found ${candidates.length} workflow pattern(s) that could be crystallized into dedicated tools:\n\n`;

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      message += `*${i + 1}. ${c.name}*\n`;
      message += `${c.description}\n`;
      message += `Chain: ${c.tool_sequence.join(' -> ')}\n`;
      message += `Used ${c.occurrence_count}x (${c.success_rate}% success)\n`;
      message += `_${c.rationale}_\n\n`;
    }

    message += `Reply with the number(s) to forge, or "skip" to defer.`;

    await sendWhatsAppMessage(phone, message);

    // Store proposals as pending actions for approval tracking
    for (const candidate of candidates) {
      await query(
        `INSERT INTO pending_actions (tool_name, tool_input, preview_text, conversation_id)
         VALUES ('code_forge', $1, $2, (SELECT id FROM conversations ORDER BY created_at DESC LIMIT 1))`,
        [
          JSON.stringify({
            name: candidate.name,
            description: candidate.description,
            rationale: candidate.rationale,
            category: 'action',
          }),
          `Foundry: crystallize ${candidate.tool_sequence.join(' -> ')} into ${candidate.name}`,
        ]
      );

      // Mark the pattern as crystallized (proposed)
      const hash = crypto
        .createHash('sha256')
        .update(candidate.tool_sequence.sort().join('|'))
        .digest('hex')
        .slice(0, 16);

      await query(
        `UPDATE workflow_patterns SET crystallized = true WHERE pattern_hash = $1`,
        [hash]
      );
    }

    logger.info('Foundry proposals sent', { count: candidates.length });
    dashboardBus.publish({ type: 'foundry_proposals', data: { count: candidates.length, proposals: candidates.map(c => c.name) } });

  } catch (err) {
    logger.error('Foundry analysis failed', { error: err });
  }
}

/**
 * Get foundry stats for the dashboard.
 */
export async function getFoundryStats(): Promise<{
  totalPatterns: number;
  uniquePatterns: number;
  crystallized: number;
  topPatterns: Array<{ tools: string[]; count: number; success_rate: number }>;
}> {
  const [total, unique, crystallized, top] = await Promise.all([
    query('SELECT COUNT(*) FROM workflow_patterns'),
    query('SELECT COUNT(DISTINCT pattern_hash) FROM workflow_patterns'),
    query('SELECT COUNT(DISTINCT pattern_hash) FROM workflow_patterns WHERE crystallized = true'),
    query(
      `SELECT tool_sequence as tools, COUNT(*) as count,
         ROUND(COUNT(*) FILTER (WHERE success)::numeric / COUNT(*)::numeric * 100, 1) as success_rate
       FROM workflow_patterns
       WHERE created_at > NOW() - INTERVAL '30 days'
       GROUP BY tool_sequence
       ORDER BY COUNT(*) DESC
       LIMIT 10`
    ),
  ]);

  return {
    totalPatterns: Number(total.rows[0].count),
    uniquePatterns: Number(unique.rows[0].count),
    crystallized: Number(crystallized.rows[0].count),
    topPatterns: top.rows.map((r: any) => ({
      tools: r.tools,
      count: Number(r.count),
      success_rate: Number(r.success_rate),
    })),
  };
}

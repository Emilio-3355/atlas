import { getToolUsageStats, getToolSequences, getRecentFailures } from './observer.js';
import { getFailurePatterns, findRelevantLearnings } from '../memory/learnings.js';
import { callClaude, extractTextContent } from '../agent/claude-client.js';
import { sendWhatsAppMessage } from '../services/whatsapp.js';
import { getEnv } from '../config/env.js';
import { query } from '../config/database.js';
import Anthropic from '@anthropic-ai/sdk';
import logger from '../utils/logger.js';

// The Capability Evolver — runs daily, analyzes patterns, proposes improvements
export async function runEvolutionCycle(): Promise<void> {
  logger.info('Running capability evolution cycle');

  const [stats, sequences, failures, recentFailures] = await Promise.all([
    getToolUsageStats(14),
    getToolSequences(14),
    getFailurePatterns(undefined, 10),
    getRecentFailures(20),
  ]);

  // Skip if not enough data
  const totalUses = stats.reduce((sum, s) => sum + s.totalUses, 0);
  if (totalUses < 20) {
    logger.info('Not enough usage data for evolution cycle', { totalUses });
    return;
  }

  // Build analysis prompt
  const analysisPrompt = buildAnalysisPrompt(stats, sequences, failures, recentFailures);

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: analysisPrompt }];

  const response = await callClaude({
    messages,
    system: `You are Atlas's self-improvement engine. Analyze tool usage patterns and propose actionable improvements.

You can propose:
1. NEW TOOLS — when a pattern is repeated 5+ times
2. WORKFLOW OPTIMIZATIONS — when tool sequences are common
3. ERROR FIXES — when a tool frequently fails
4. CAPABILITY UPGRADES — when existing tools could be improved

Format each proposal as:
TYPE: [new_tool|workflow|fix|upgrade]
NAME: [name]
DESCRIPTION: [what it does]
RATIONALE: [why, with specific numbers]
PRIORITY: [high|medium|low]
---

Only propose things with strong evidence. Never propose more than 3 items.
If there's nothing worth proposing, say "NO_PROPOSALS".`,
    depth: 'expert',
    maxTokens: 2000,
  });

  const analysisText = extractTextContent(response.content);

  if (analysisText.includes('NO_PROPOSALS')) {
    logger.info('Evolution cycle: no proposals this cycle');
    return;
  }

  // Parse proposals
  const proposals = parseProposals(analysisText);

  if (proposals.length === 0) return;

  // Check cooldowns (don't re-propose recently rejected items)
  const filteredProposals = await filterCooldowns(proposals);

  if (filteredProposals.length === 0) return;

  // Store proposals and notify JP
  const phone = getEnv().JP_PHONE_NUMBER;
  let message = '🧬 *Atlas Evolution Report*\n\n';
  message += `Based on ${totalUses} tool uses over 14 days, I have ${filteredProposals.length} proposal(s):\n\n`;

  for (let i = 0; i < filteredProposals.length; i++) {
    const p = filteredProposals[i];
    message += `*${i + 1}. [${p.type.toUpperCase()}] ${p.name}*\n`;
    message += `${p.description}\n`;
    message += `_Reason: ${p.rationale}_\n`;
    message += `Priority: ${p.priority}\n\n`;

    // Store in DB
    await query(
      `INSERT INTO tool_definitions (name, description, input_schema, implementation_type, rationale, status)
       VALUES ($1, $2, '{}', $3, $4, 'proposed')
       ON CONFLICT (name) DO UPDATE SET rationale = $4, proposed_at = NOW()`,
      [p.name, p.description, p.type, p.rationale]
    );
  }

  message += 'Reply with a number to approve, or "skip" to pass on all.';

  await sendWhatsAppMessage(phone, message);
  logger.info('Evolution proposals sent', { count: filteredProposals.length });
}

interface Proposal {
  type: string;
  name: string;
  description: string;
  rationale: string;
  priority: string;
}

function buildAnalysisPrompt(
  stats: any[],
  sequences: Record<string, number>,
  failures: any[],
  recentFailures: any[],
): string {
  let prompt = 'Analyze these Atlas tool usage patterns from the last 14 days:\n\n';

  prompt += '*Tool Usage Stats:*\n';
  for (const s of stats.slice(0, 15)) {
    prompt += `• ${s.toolName}: ${s.totalUses} uses, ${(s.successRate * 100).toFixed(0)}% success, avg ${s.avgDurationMs}ms\n`;
  }

  prompt += '\n*Common Tool Sequences:*\n';
  const topSequences = Object.entries(sequences).slice(0, 10);
  for (const [seq, count] of topSequences) {
    prompt += `• ${seq}: ${count} times\n`;
  }

  if (failures.length > 0) {
    prompt += '\n*Recurring Failure Patterns:*\n';
    for (const f of failures.slice(0, 5)) {
      prompt += `• ${f.taskDescription.slice(0, 100)} — ${f.outcome} (${f.patternCount}x)\n`;
      if (f.reflection) prompt += `  Reflection: ${f.reflection.slice(0, 100)}\n`;
    }
  }

  if (recentFailures.length > 0) {
    prompt += '\n*Recent Failures:*\n';
    for (const f of recentFailures.slice(0, 5)) {
      prompt += `• ${f.tool_name}: ${f.error_message?.slice(0, 100) || 'unknown error'}\n`;
    }
  }

  prompt += '\nBased on this data, what improvements would have the highest impact?';

  return prompt;
}

function parseProposals(text: string): Proposal[] {
  const proposals: Proposal[] = [];
  const blocks = text.split('---').filter((b) => b.trim());

  for (const block of blocks) {
    const typeMatch = block.match(/TYPE:\s*(\w+)/i);
    const nameMatch = block.match(/NAME:\s*(.+)/i);
    const descMatch = block.match(/DESCRIPTION:\s*(.+)/i);
    const rationaleMatch = block.match(/RATIONALE:\s*(.+)/i);
    const priorityMatch = block.match(/PRIORITY:\s*(\w+)/i);

    if (typeMatch && nameMatch && descMatch) {
      proposals.push({
        type: typeMatch[1].toLowerCase(),
        name: nameMatch[1].trim(),
        description: descMatch[1].trim(),
        rationale: rationaleMatch?.[1]?.trim() || 'Pattern detected in usage data',
        priority: priorityMatch?.[1]?.toLowerCase() || 'medium',
      });
    }
  }

  return proposals;
}

async function filterCooldowns(proposals: Proposal[]): Promise<Proposal[]> {
  const filtered: Proposal[] = [];

  for (const p of proposals) {
    // Check if this was rejected in the last 30 days
    const result = await query(
      `SELECT id FROM tool_definitions
       WHERE name = $1 AND status = 'rejected' AND proposed_at > NOW() - INTERVAL '30 days'`,
      [p.name]
    );

    if (result.rows.length === 0) {
      filtered.push(p);
    }
  }

  return filtered;
}

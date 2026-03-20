import crypto from 'crypto';
import { getToolUsageStats, getToolSequences, getRecentFailures } from './observer.js';
import { getFailurePatterns } from '../memory/learnings.js';
import { getStalenessReport } from './staleness-detector.js';
import { callClaude, extractTextContent } from '../agent/claude-client.js';
import { sendWhatsAppMessage } from '../services/whatsapp.js';
import { getEnv } from '../config/env.js';
import { query } from '../config/database.js';
import Anthropic from '@anthropic-ai/sdk';
import logger from '../utils/logger.js';

// ===== SAFETY CONSTANTS =====

// ABSOLUTE: Atlas NEVER modifies its own source code. All changes are proposals for JP.
const MAX_PROPOSALS_PER_CYCLE = 3;
const MIN_USAGE_DATA = 20;
const COOLDOWN_DAYS = 30;
const CIRCUIT_BREAKER_WINDOW = 8; // last N cycles to check for repair loops
const CIRCUIT_BREAKER_REPAIR_THRESHOLD = 0.5; // if 50%+ were repairs, force innovate

// Strategy presets — define intent distribution for each strategy
const STRATEGY_PRESETS: Record<string, { repair: number; optimize: number; innovate: number; repairLoopMax: number }> = {
  balanced:    { repair: 50, optimize: 30, innovate: 20, repairLoopMax: 4 },
  innovate:    { repair: 20, optimize: 15, innovate: 65, repairLoopMax: 2 },
  harden:      { repair: 60, optimize: 30, innovate: 10, repairLoopMax: 6 },
  repair_only: { repair: 80, optimize: 15, innovate: 5,  repairLoopMax: 7 },
};

// ===== TYPES =====

interface Proposal {
  type: 'repair' | 'optimize' | 'innovate';
  name: string;
  description: string;
  rationale: string;
  priority: 'high' | 'medium' | 'low';
  hash: string; // content-addressable ID for deduplication
}

interface EvolutionEvent {
  cycleNumber: number;
  intent: string;
  signals: string[];
  proposals: Proposal[];
  outcome: string;
  statsSnapshot: Record<string, any>;
  stalenessReport: string;
  durationMs: number;
}

// ===== MAIN EVOLUTION CYCLE =====

/**
 * Atlas Safe Capability Evolver
 *
 * Inspired by GEP Protocol concepts but with fundamental safety differences:
 * - NEVER auto-executes changes ("Mad Dog Mode" is not implemented and never will be)
 * - ALL proposals require JP's explicit WhatsApp approval
 * - Immutable audit trail of every cycle
 * - Circuit breaker prevents infinite repair loops
 * - Content-addressable proposal hashing for deduplication
 * - Staleness integration — factors in outdated knowledge
 */
export async function runEvolutionCycle(): Promise<void> {
  const startTime = Date.now();
  const cycleNumber = await incrementCycleCount();

  logger.info('Evolution cycle starting', { cycle: cycleNumber });

  try {
    // 1. Signal extraction — gather all data sources
    const [stats, sequences, failures, recentFailures, stalenessReport, correctionCount] =
      await Promise.all([
        getToolUsageStats(14),
        getToolSequences(14),
        getFailurePatterns(undefined, 10),
        getRecentFailures(20),
        getStalenessReport(),
        getRecentCorrectionCount(14),
      ]);

    // Skip if not enough data
    const totalUses = stats.reduce((sum, s) => sum + s.totalUses, 0);
    if (totalUses < MIN_USAGE_DATA) {
      await recordEvent({
        cycleNumber,
        intent: 'none',
        signals: ['insufficient_data'],
        proposals: [],
        outcome: 'no_proposals',
        statsSnapshot: { totalUses },
        stalenessReport: '',
        durationMs: Date.now() - startTime,
      });
      logger.info('Evolution: not enough data', { totalUses });
      return;
    }

    // 2. Determine intent — what should this cycle focus on?
    const intent = await determineIntent(stats, failures, recentFailures);

    // 3. Extract signals from all data sources
    const signals = extractSignals(stats, sequences, failures, recentFailures, correctionCount);

    // 4. Build analysis prompt and get proposals from Claude
    const analysisPrompt = buildAnalysisPrompt(
      intent,
      stats,
      sequences,
      failures,
      recentFailures,
      stalenessReport,
      correctionCount,
    );

    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: analysisPrompt }];

    const response = await callClaude({
      messages,
      system: buildEvolverSystemPrompt(intent),
      depth: 'expert',
      maxTokens: 2000,
    });

    const analysisText = extractTextContent(response.content);

    if (analysisText.includes('NO_PROPOSALS')) {
      await recordEvent({
        cycleNumber,
        intent,
        signals,
        proposals: [],
        outcome: 'no_proposals',
        statsSnapshot: buildStatsSnapshot(stats, totalUses),
        stalenessReport,
        durationMs: Date.now() - startTime,
      });
      logger.info('Evolution: no proposals this cycle', { intent });
      return;
    }

    // 5. Parse and hash proposals
    const rawProposals = parseProposals(analysisText);
    const proposals = rawProposals.map((p) => ({
      ...p,
      hash: hashProposal(p),
    }));

    if (proposals.length === 0) {
      await recordEvent({
        cycleNumber,
        intent,
        signals,
        proposals: [],
        outcome: 'no_proposals',
        statsSnapshot: buildStatsSnapshot(stats, totalUses),
        stalenessReport,
        durationMs: Date.now() - startTime,
      });
      return;
    }

    // 6. Deduplicate — skip proposals we've already made (by content hash)
    const deduped = await deduplicateProposals(proposals);

    // 7. Filter cooldowns (recently rejected)
    const filtered = await filterCooldowns(deduped);

    if (filtered.length === 0) {
      await recordEvent({
        cycleNumber,
        intent,
        signals,
        proposals,
        outcome: 'skipped',
        statsSnapshot: buildStatsSnapshot(stats, totalUses),
        stalenessReport,
        durationMs: Date.now() - startTime,
      });
      logger.info('Evolution: all proposals filtered by cooldown/dedup');
      return;
    }

    // 8. Record audit event
    await recordEvent({
      cycleNumber,
      intent,
      signals,
      proposals: filtered,
      outcome: 'proposed',
      statsSnapshot: buildStatsSnapshot(stats, totalUses),
      stalenessReport,
      durationMs: Date.now() - startTime,
    });

    // 9. Store proposals in DB and notify JP (ALWAYS requires approval)
    await storeAndNotify(filtered, totalUses, intent, cycleNumber);

    // 10. Track intent for circuit breaker
    await trackIntent(intent);

    logger.info('Evolution cycle complete', {
      cycle: cycleNumber,
      intent,
      proposals: filtered.length,
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    await recordEvent({
      cycleNumber,
      intent: 'error',
      signals: [],
      proposals: [],
      outcome: 'error',
      statsSnapshot: {},
      stalenessReport: '',
      durationMs: Date.now() - startTime,
    });
    logger.error('Evolution cycle failed', { cycle: cycleNumber, error: err });
  }
}

// ===== INTENT DETERMINATION =====

async function determineIntent(
  stats: any[],
  failures: any[],
  recentFailures: any[],
): Promise<string> {
  const strategy = await getStrategy();
  const preset = STRATEGY_PRESETS[strategy] || STRATEGY_PRESETS.balanced;

  // Check circuit breaker — are we stuck in a repair loop?
  const consecutiveRepairs = await getConsecutiveRepairs();
  if (consecutiveRepairs >= preset.repairLoopMax) {
    logger.warn('Circuit breaker: too many consecutive repairs, forcing innovate', {
      consecutiveRepairs,
      threshold: preset.repairLoopMax,
    });
    await setEvolutionState('circuit_breaker_tripped', true);
    return 'innovate';
  }

  // Score each intent based on signals
  const failureRate = stats.length > 0
    ? stats.reduce((sum, s) => sum + (1 - s.successRate) * s.totalUses, 0) / stats.reduce((sum, s) => sum + s.totalUses, 0)
    : 0;

  const hasHighFailures = recentFailures.length >= 5 || failureRate > 0.2;
  const hasRecurringPatterns = failures.filter((f) => f.patternCount >= 3).length > 0;

  if (hasHighFailures && hasRecurringPatterns) return 'repair';
  if (failureRate > 0.1) return 'optimize';

  // Use strategy preset weights for probabilistic selection
  const roll = Math.random() * 100;
  if (roll < preset.repair) return 'repair';
  if (roll < preset.repair + preset.optimize) return 'optimize';
  return 'innovate';
}

// ===== SIGNAL EXTRACTION =====

function extractSignals(
  stats: any[],
  sequences: Record<string, number>,
  failures: any[],
  recentFailures: any[],
  correctionCount: number,
): string[] {
  const signals: string[] = [];

  // High-failure tools
  for (const s of stats) {
    if (s.totalUses >= 5 && s.successRate < 0.5) {
      signals.push(`high_failure:${s.toolName}:${(s.successRate * 100).toFixed(0)}%`);
    }
  }

  // Frequent sequences
  for (const [seq, count] of Object.entries(sequences)) {
    if (count >= 5) signals.push(`frequent_sequence:${seq}:${count}x`);
  }

  // Recurring failure patterns
  for (const f of failures) {
    if (f.patternCount >= 3) signals.push(`recurring_failure:${f.taskDescription.slice(0, 50)}:${f.patternCount}x`);
  }

  // Recent failure spike
  if (recentFailures.length >= 10) signals.push(`failure_spike:${recentFailures.length}_in_7d`);

  // User corrections
  if (correctionCount > 0) signals.push(`user_corrections:${correctionCount}_in_14d`);

  return signals;
}

// ===== PROPOSAL PARSING & HASHING =====

function parseProposals(text: string): Omit<Proposal, 'hash'>[] {
  const proposals: Omit<Proposal, 'hash'>[] = [];
  const blocks = text.split('---').filter((b) => b.trim());

  for (const block of blocks) {
    if (proposals.length >= MAX_PROPOSALS_PER_CYCLE) break;

    const typeMatch = block.match(/TYPE:\s*(\w+)/i);
    const nameMatch = block.match(/NAME:\s*(.+)/i);
    const descMatch = block.match(/DESCRIPTION:\s*(.+)/i);
    const rationaleMatch = block.match(/RATIONALE:\s*(.+)/i);
    const priorityMatch = block.match(/PRIORITY:\s*(\w+)/i);

    if (typeMatch && nameMatch && descMatch) {
      const rawType = typeMatch[1].toLowerCase();
      const type = rawType === 'fix' ? 'repair'
        : rawType === 'new_tool' ? 'innovate'
        : rawType === 'upgrade' ? 'optimize'
        : rawType === 'workflow' ? 'optimize'
        : (rawType as 'repair' | 'optimize' | 'innovate');

      proposals.push({
        type,
        name: nameMatch[1].trim(),
        description: descMatch[1].trim(),
        rationale: rationaleMatch?.[1]?.trim() || 'Pattern detected in usage data',
        priority: (priorityMatch?.[1]?.toLowerCase() || 'medium') as 'high' | 'medium' | 'low',
      });
    }
  }

  return proposals;
}

/**
 * Content-addressable hash for proposal deduplication.
 * Same concept as GEP Protocol's SHA-256 Gene IDs, but for proposals.
 */
function hashProposal(p: Omit<Proposal, 'hash'>): string {
  const canonical = JSON.stringify({ type: p.type, name: p.name, description: p.description });
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

// ===== DEDUPLICATION & COOLDOWN =====

async function deduplicateProposals(proposals: Proposal[]): Promise<Proposal[]> {
  const unique: Proposal[] = [];

  for (const p of proposals) {
    // Check if this exact proposal (by hash) was already proposed in the last 14 days
    const existing = await query(
      `SELECT id FROM evolution_events
       WHERE proposals::text LIKE $1
         AND created_at > NOW() - INTERVAL '14 days'
       LIMIT 1`,
      [`%${p.hash}%`]
    );

    if (existing.rows.length === 0) {
      unique.push(p);
    } else {
      logger.debug('Proposal deduped', { name: p.name, hash: p.hash });
    }
  }

  return unique;
}

async function filterCooldowns(proposals: Proposal[]): Promise<Proposal[]> {
  const filtered: Proposal[] = [];

  for (const p of proposals) {
    // Check both tool_definitions (legacy) AND evolution_events for recent rejections
    const result = await query(
      `SELECT id FROM (
         SELECT id FROM tool_definitions
         WHERE name = $1 AND status = 'rejected' AND proposed_at > NOW() - INTERVAL '1 day' * $2
         UNION ALL
         SELECT id FROM evolution_events
         WHERE outcome = 'rejected'
           AND proposals::text LIKE $3
           AND created_at > NOW() - INTERVAL '1 day' * $2
       ) AS combined LIMIT 1`,
      [p.name, COOLDOWN_DAYS, `%${p.name}%`]
    );

    if (result.rows.length === 0) {
      filtered.push(p);
    }
  }

  return filtered;
}

// ===== NOTIFY JP (ALWAYS REQUIRES APPROVAL) =====

async function storeAndNotify(
  proposals: Proposal[],
  totalUses: number,
  intent: string,
  cycleNumber: number,
): Promise<void> {
  const phone = getEnv().JP_PHONE_NUMBER;

  const intentEmoji = intent === 'repair' ? '🔧' : intent === 'optimize' ? '⚡' : '💡';
  let message = `🧬 *Atlas Evolution #${cycleNumber}* ${intentEmoji}\n\n`;
  message += `Mode: *${intent}* | Based on ${totalUses} tool uses over 14 days\n\n`;

  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i];
    const typeTag = p.type === 'repair' ? '🔧' : p.type === 'optimize' ? '⚡' : '💡';

    message += `*${i + 1}.* ${typeTag} *${p.name}*\n`;
    message += `${p.description}\n`;
    message += `_${p.rationale}_\n`;
    message += `Priority: ${p.priority} | ID: ${p.hash.slice(0, 8)}\n\n`;

    // Store in DB
    await query(
      `INSERT INTO tool_definitions (name, description, input_schema, implementation_type, rationale, status)
       VALUES ($1, $2, '{}', $3, $4, 'proposed')
       ON CONFLICT (name) DO UPDATE SET rationale = $4, proposed_at = NOW()`,
      [p.name, p.description, p.type, p.rationale]
    );
  }

  message += 'Reply with a number to approve, or "skip" to pass.';

  await sendWhatsAppMessage(phone, message);
  logger.info('Evolution proposals sent', { cycle: cycleNumber, count: proposals.length });
}

// ===== PROMPT BUILDING =====

function buildEvolverSystemPrompt(intent: string): string {
  return `You are Atlas's self-improvement engine. You analyze tool usage patterns and propose actionable improvements.

CURRENT INTENT: ${intent.toUpperCase()}
${intent === 'repair' ? '- Focus on fixing recurring failures and errors' : ''}
${intent === 'optimize' ? '- Focus on streamlining common tool sequences and improving performance' : ''}
${intent === 'innovate' ? '- Focus on identifying capability gaps and proposing new tools/workflows' : ''}

You can propose (max ${MAX_PROPOSALS_PER_CYCLE}):
1. TYPE: repair — Fix a recurring failure or error
2. TYPE: optimize — Streamline a workflow or improve an existing tool
3. TYPE: innovate — Propose a new tool or capability

Format each proposal as:
TYPE: [repair|optimize|innovate]
NAME: [name]
DESCRIPTION: [what it does]
RATIONALE: [why, with specific data/numbers from the analysis]
PRIORITY: [high|medium|low]
---

SAFETY RULES:
- NEVER propose modifying Atlas's own source code or security rules
- NEVER propose changes to authentication, encryption, or access control
- Only propose things with strong evidence from the data
- All proposals will be reviewed by JP before any action is taken
- If there's nothing worth proposing, say "NO_PROPOSALS"`;
}

function buildAnalysisPrompt(
  intent: string,
  stats: any[],
  sequences: Record<string, number>,
  failures: any[],
  recentFailures: any[],
  stalenessReport: string,
  correctionCount: number,
): string {
  let prompt = `Analyze Atlas's patterns from the last 14 days (intent: ${intent}):\n\n`;

  prompt += '*Tool Usage Stats:*\n';
  for (const s of stats.slice(0, 15)) {
    prompt += `  ${s.toolName}: ${s.totalUses} uses, ${(s.successRate * 100).toFixed(0)}% success, avg ${s.avgDurationMs}ms\n`;
  }

  prompt += '\n*Common Tool Sequences:*\n';
  const topSequences = Object.entries(sequences).slice(0, 10);
  for (const [seq, count] of topSequences) {
    prompt += `  ${seq}: ${count} times\n`;
  }

  if (failures.length > 0) {
    prompt += '\n*Recurring Failure Patterns:*\n';
    for (const f of failures.slice(0, 5)) {
      prompt += `  ${f.taskDescription.slice(0, 100)} — ${f.outcome} (${f.patternCount}x)\n`;
      if (f.reflection) prompt += `    Reflection: ${f.reflection.slice(0, 100)}\n`;
    }
  }

  if (recentFailures.length > 0) {
    prompt += '\n*Recent Failures (last 7 days):*\n';
    for (const f of recentFailures.slice(0, 5)) {
      prompt += `  ${f.tool_name}: ${f.error_message?.slice(0, 100) || 'unknown error'}\n`;
    }
  }

  if (stalenessReport) {
    prompt += `\n${stalenessReport}\n`;
  }

  if (correctionCount > 0) {
    prompt += `\n*User Corrections:* ${correctionCount} times JP corrected Atlas in the last 14 days.\n`;
  }

  prompt += '\nBased on this data, what improvements would have the highest impact?';

  return prompt;
}

// ===== STATS SNAPSHOT =====

function buildStatsSnapshot(stats: any[], totalUses: number): Record<string, any> {
  return {
    totalUses,
    toolCount: stats.length,
    avgSuccessRate: stats.length > 0
      ? stats.reduce((sum, s) => sum + s.successRate, 0) / stats.length
      : 0,
    topTools: stats.slice(0, 5).map((s) => ({ name: s.toolName, uses: s.totalUses })),
  };
}

// ===== AUDIT TRAIL (IMMUTABLE) =====

async function recordEvent(event: EvolutionEvent): Promise<void> {
  try {
    await query(
      `INSERT INTO evolution_events (cycle_number, intent, signals, proposals, outcome, stats_snapshot, staleness_report, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        event.cycleNumber,
        event.intent,
        JSON.stringify(event.signals),
        JSON.stringify(event.proposals),
        event.outcome,
        JSON.stringify(event.statsSnapshot),
        event.stalenessReport || null,
        event.durationMs,
      ]
    );
  } catch (err) {
    logger.error('Failed to record evolution event', { error: err });
  }
}

// ===== STATE MANAGEMENT =====

async function getEvolutionState(key: string): Promise<any> {
  const result = await query('SELECT value FROM evolution_state WHERE key = $1', [key]);
  return result.rows.length > 0 ? JSON.parse(result.rows[0].value) : null;
}

async function setEvolutionState(key: string, value: any): Promise<void> {
  await query(
    `INSERT INTO evolution_state (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
}

async function incrementCycleCount(): Promise<number> {
  const current = (await getEvolutionState('cycle_count')) || 0;
  const next = current + 1;
  await setEvolutionState('cycle_count', next);
  return next;
}

async function getStrategy(): Promise<string> {
  return (await getEvolutionState('strategy')) || 'balanced';
}

async function getConsecutiveRepairs(): Promise<number> {
  const result = await query(
    `SELECT intent FROM evolution_events
     WHERE outcome IN ('proposed', 'approved')
     ORDER BY created_at DESC LIMIT $1`,
    [CIRCUIT_BREAKER_WINDOW]
  );

  let count = 0;
  for (const row of result.rows) {
    if (row.intent === 'repair') count++;
    else break; // Stop at first non-repair
  }
  return count;
}

async function trackIntent(intent: string): Promise<void> {
  if (intent === 'repair') {
    const current = (await getEvolutionState('consecutive_repairs')) || 0;
    await setEvolutionState('consecutive_repairs', current + 1);
  } else {
    await setEvolutionState('consecutive_repairs', 0);
    await setEvolutionState('circuit_breaker_tripped', false);
  }
}

// ===== HELPER: COUNT CORRECTIONS =====

async function getRecentCorrectionCount(days: number): Promise<number> {
  try {
    const result = await query(
      `SELECT COUNT(*) AS count FROM audit_log
       WHERE action_type IN ('auto_correction_detected', 'auto_staleness_detected')
         AND created_at > NOW() - INTERVAL '1 day' * $1`,
      [days]
    );
    return Number(result.rows[0]?.count || 0);
  } catch {
    return 0;
  }
}

// ===== PUBLIC: Get evolution history for dashboard/review =====

export async function getEvolutionHistory(limit: number = 10): Promise<any[]> {
  const result = await query(
    `SELECT * FROM evolution_events ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}

export async function getEvolutionState_public(): Promise<Record<string, any>> {
  const result = await query('SELECT key, value FROM evolution_state');
  const state: Record<string, any> = {};
  for (const row of result.rows) {
    state[row.key] = JSON.parse(row.value);
  }
  return state;
}

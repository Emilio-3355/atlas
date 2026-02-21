import { query } from '../config/database.js';
import { searchFacts, upsertFact } from '../memory/structured.js';
import { recordLearning } from '../memory/learnings.js';
import logger from '../utils/logger.js';

// Tools whose results might reveal outdated knowledge
const KNOWLEDGE_TOOLS = ['web_search', 'browse', 'read_email', 'calendar_read', 'recall'];

// Maximum age (days) before a fact is considered potentially stale
const STALENESS_THRESHOLDS: Record<string, number> = {
  contact: 180,      // contacts change infrequently
  preference: 90,    // preferences can change
  schedule: 7,       // schedules change weekly
  booking: 1,        // bookings are time-sensitive
  finance: 30,       // financial info changes monthly
  general: 60,       // general facts need periodic verification
};

interface StalenessSignal {
  factId: string;
  factKey: string;
  factValue: string;
  reason: string;
  daysSinceUpdate: number;
}

/**
 * Check structured memory facts for staleness.
 * Run periodically (e.g. daily) to flag facts that haven't been verified recently.
 */
export async function detectStaleness(): Promise<StalenessSignal[]> {
  const staleSignals: StalenessSignal[] = [];

  for (const [category, thresholdDays] of Object.entries(STALENESS_THRESHOLDS)) {
    const result = await query(
      `SELECT id, category, key, value, source, confidence, updated_at,
              EXTRACT(EPOCH FROM (NOW() - updated_at)) / 86400 AS days_since_update
       FROM memory_facts
       WHERE category = $1
         AND (expires_at IS NULL OR expires_at > NOW())
         AND updated_at < NOW() - INTERVAL '1 day' * $2
       ORDER BY updated_at ASC
       LIMIT 10`,
      [category, thresholdDays]
    );

    for (const row of result.rows) {
      staleSignals.push({
        factId: row.id,
        factKey: row.key,
        factValue: row.value,
        reason: `Fact [${row.category}] "${row.key}" hasn't been updated in ${Math.round(row.days_since_update)} days (threshold: ${thresholdDays} days)`,
        daysSinceUpdate: Math.round(Number(row.days_since_update)),
      });
    }
  }

  if (staleSignals.length > 0) {
    logger.info('Staleness check found potentially stale facts', { count: staleSignals.length });

    // Reduce confidence of stale facts (don't delete — just lower trust)
    for (const signal of staleSignals) {
      await query(
        `UPDATE memory_facts SET confidence = GREATEST(confidence * 0.8, 0.3)
         WHERE id = $1 AND confidence > 0.3`,
        [signal.factId]
      );
    }
  }

  return staleSignals;
}

/**
 * When a tool returns results, check if they contradict stored memory facts.
 * For example: web_search returns a new address for a contact, but memory has the old one.
 */
export async function handleStalenessFromToolResult(
  toolName: string,
  toolData: any,
  conversationId: string,
): Promise<void> {
  if (!KNOWLEDGE_TOOLS.includes(toolName)) return;

  // For web search results, check if any returned content contradicts stored facts
  const dataStr = typeof toolData === 'string' ? toolData : JSON.stringify(toolData);

  // Don't check tiny or huge results (not meaningful)
  if (dataStr.length < 20 || dataStr.length > 10000) return;

  try {
    // Search for facts that are topically related to the tool result
    const relatedFacts = await searchFacts(dataStr.slice(0, 200), 5);

    for (const fact of relatedFacts) {
      // Check if the fact is old enough to worry about
      const daysSinceUpdate = (Date.now() - new Date(fact.updatedAt).getTime()) / 86400000;
      const threshold = STALENESS_THRESHOLDS[fact.category] || 60;

      if (daysSinceUpdate > threshold * 0.5) {
        // Flag this fact as needing verification (lower confidence slightly)
        await query(
          `UPDATE memory_facts SET confidence = GREATEST(confidence - 0.05, 0.3)
           WHERE id = $1 AND confidence > 0.3`,
          [fact.id]
        );

        // Record a learning about potentially stale info
        await recordLearning(
          `Potential staleness in [${fact.category}] "${fact.key}": "${fact.value.slice(0, 100)}"`,
          `Tool ${toolName} returned data that may be newer. Fact is ${Math.round(daysSinceUpdate)} days old.`,
          'partial',
          `Fact [${fact.category}] ${fact.key} may need verification — last updated ${Math.round(daysSinceUpdate)} days ago, threshold is ${threshold} days.`,
        );

        logger.debug('Potential staleness flagged from tool result', {
          factKey: fact.key,
          toolName,
          daysSinceUpdate: Math.round(daysSinceUpdate),
        });
      }
    }
  } catch (err) {
    // Non-critical
    logger.debug('Staleness check from tool result failed', { error: err });
  }
}

/**
 * Get a summary of stale facts for the evolution cycle to analyze.
 */
export async function getStalenessReport(): Promise<string> {
  const result = await query(
    `SELECT category, key, value, confidence,
            EXTRACT(EPOCH FROM (NOW() - updated_at)) / 86400 AS days_since_update
     FROM memory_facts
     WHERE confidence < 0.7 AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY confidence ASC, days_since_update DESC
     LIMIT 15`
  );

  if (result.rows.length === 0) return '';

  let report = '*Potentially Stale Facts (low confidence):*\n';
  for (const row of result.rows) {
    report += `  [${row.category}] ${row.key}: "${row.value.slice(0, 60)}" `;
    report += `(confidence: ${(row.confidence * 100).toFixed(0)}%, age: ${Math.round(row.days_since_update)}d)\n`;
  }

  return report;
}

import { getToolUsageStats, getToolSequences } from './observer.js';
import { query } from '../config/database.js';
import { sendWhatsAppMessage } from '../services/whatsapp.js';
import { getEnv } from '../config/env.js';
import logger from '../utils/logger.js';

const MIN_OCCURRENCES = 5;
const MIN_SUCCESS_RATE = 0.7;
const COOLDOWN_DAYS = 30;

interface CrystallizedPattern {
  type: 'tool' | 'workflow';
  name: string;
  description: string;
  rationale: string;
  basedOn: string;
  occurrences: number;
}

// Run every 24 hours: analyze tool usage patterns and propose improvements
export async function crystallize(): Promise<CrystallizedPattern[]> {
  const stats = await getToolUsageStats(14);
  const sequences = await getToolSequences(14);
  const proposals: CrystallizedPattern[] = [];

  // Pattern 1: Frequently used tool sequences → propose workflow
  for (const [sequence, count] of Object.entries(sequences)) {
    if (count >= MIN_OCCURRENCES) {
      const [from, to] = sequence.split(' -> ');

      // Check if we already proposed this recently
      const existing = await query(
        `SELECT id FROM tool_definitions
         WHERE name LIKE $1 AND proposed_at > NOW() - INTERVAL '1 day' * $2`,
        [`%${from}%${to}%`, COOLDOWN_DAYS]
      );

      if (existing.rows.length > 0) continue;

      proposals.push({
        type: 'workflow',
        name: `auto_${from}_then_${to}`,
        description: `Automatically run ${to} after ${from}`,
        rationale: `You've used ${from} → ${to} ${count} times in the last 2 weeks`,
        basedOn: sequence,
        occurrences: count,
      });
    }
  }

  // Pattern 2: High-failure tools → suggest improvement
  for (const stat of stats) {
    if (stat.totalUses >= MIN_OCCURRENCES && stat.successRate < 0.5) {
      logger.warn('High-failure tool detected', {
        tool: stat.toolName,
        successRate: stat.successRate,
        totalUses: stat.totalUses,
      });
    }
  }

  // Send proposals to JP if any
  if (proposals.length > 0) {
    const phone = getEnv().JP_PHONE_NUMBER;
    let message = '🧠 *Atlas Self-Improvement Proposals:*\n\n';
    message += "I've noticed some patterns in how you use me:\n\n";

    for (const p of proposals) {
      message += `• *${p.name}*: ${p.description}\n  _Reason: ${p.rationale}_\n\n`;
    }

    message += 'Want me to create any of these? Reply with the name(s) to approve.';

    await sendWhatsAppMessage(phone, message);
    logger.info('Crystallization proposals sent', { count: proposals.length });
  }

  return proposals;
}

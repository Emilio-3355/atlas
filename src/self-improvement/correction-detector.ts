import { recordLearning } from '../memory/learnings.js';
import { query } from '../config/database.js';
import logger from '../utils/logger.js';

// Patterns that indicate the user is correcting Atlas
const CORRECTION_PATTERNS: RegExp[] = [
  // English corrections
  /\b(no[,.]?\s+(that'?s?\s+)?(wrong|incorrect|not\s+right|not\s+what))/i,
  /\b(actually[,.]?\s+(it'?s?|that'?s?|the|i|we|you))/i,
  /\b(that'?s?\s+not\s+(correct|right|true|accurate|what\s+i))/i,
  /\b(you('re|\s+are)\s+(wrong|mistaken|confused|incorrect))/i,
  /\b(i\s+(said|meant|asked\s+for|wanted)\s+.{2,}not\b)/i,
  /\b(not\s+that[,.]?\s+(i\s+mean|it'?s?|the))/i,
  /\b(wrong\s+(one|answer|info|information|number|date|time|name))/i,
  /\b(correct(ion)?:\s+)/i,
  /\b(let\s+me\s+correct\s+(you|that))/i,
  /\b(i\s+never\s+(said|asked|told|wanted))/i,
  /\b(that'?s?\s+outdated)/i,
  /\b(not\s+anymore|no\s+longer|changed\s+(since|now))/i,
  /\b(you\s+got\s+(it|that)\s+wrong)/i,

  // Spanish corrections
  /\b(no[,.]?\s+(eso\s+)?est[aá]\s+(mal|incorrecto|equivocado))/i,
  /\b(te\s+equivocas|est[aá]s\s+equivocado)/i,
  /\b(en\s+realidad[,.]?\s+)/i,
  /\b(eso\s+no\s+es\s+(correcto|cierto|verdad))/i,
  /\b(no\s+es\s+as[ií][,.]?\s+)/i,
  /\b(yo\s+(dije|ped[ií]|quer[ií]a)\s+.{2,}no\b)/i,
  /\b(correc(ci[oó]n|to):\s+)/i,
];

// Patterns that indicate something is outdated
const STALENESS_PATTERNS: RegExp[] = [
  /\b(that('?s)?\s+(outdated|old|stale|no\s+longer|not\s+current))/i,
  /\b(changed\s+(since|now|recently|last))/i,
  /\b(used\s+to\s+be|was\s+.+\s+but\s+now)/i,
  /\b(not\s+anymore|no\s+longer\s+(true|valid|correct|the\s+case))/i,
  /\b(they\s+(changed|updated|moved|renamed))/i,
  /\b(new\s+(address|number|email|location|price|policy))/i,
  /\b(ya\s+(no\s+es|cambi[oó]|no\s+está))/i,
  /\b(antes\s+era\s+.+\s+pero\s+ahora)/i,
];

export interface CorrectionSignal {
  type: 'correction' | 'staleness';
  confidence: number;
  matchedPattern: string;
}

/**
 * Detect if a user message is correcting Atlas's previous response.
 * Returns null if no correction detected, or a CorrectionSignal if one is found.
 */
export function detectCorrection(userMessage: string): CorrectionSignal | null {
  const trimmed = userMessage.trim();

  // Ignore very short messages (likely just "no" as denial, not correction)
  if (trimmed.length < 8) return null;

  // Check correction patterns
  for (const pattern of CORRECTION_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      return {
        type: 'correction',
        confidence: match[0].length / trimmed.length > 0.3 ? 0.9 : 0.7,
        matchedPattern: match[0],
      };
    }
  }

  // Check staleness patterns
  for (const pattern of STALENESS_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      return {
        type: 'staleness',
        confidence: 0.8,
        matchedPattern: match[0],
      };
    }
  }

  return null;
}

/**
 * When a correction is detected, record a learning from the previous assistant message.
 * This auto-fires so Atlas learns from mistakes without the user needing to invoke /reflect.
 */
export async function handleCorrection(
  conversationId: string,
  userMessage: string,
  signal: CorrectionSignal,
): Promise<void> {
  try {
    // Get the last assistant message (what Atlas said that was wrong)
    const lastAssistant = await query(
      `SELECT content FROM messages
       WHERE conversation_id = $1 AND role = 'assistant'
       ORDER BY created_at DESC LIMIT 1`,
      [conversationId]
    );

    const previousResponse = lastAssistant.rows[0]?.content || 'unknown response';

    // Get the user message before that (what prompted the wrong answer)
    const lastUserBefore = await query(
      `SELECT content FROM messages
       WHERE conversation_id = $1 AND role = 'user'
       ORDER BY created_at DESC LIMIT 2`,
      [conversationId]
    );

    const originalQuestion = lastUserBefore.rows[1]?.content || 'unknown question';

    const taskDescription = signal.type === 'correction'
      ? `User corrected Atlas response to: "${originalQuestion.slice(0, 120)}"`
      : `User flagged outdated info in response to: "${originalQuestion.slice(0, 120)}"`;

    const approach = `Atlas responded: "${previousResponse.slice(0, 200)}"`;

    const reflection = signal.type === 'correction'
      ? `User correction: "${userMessage.slice(0, 300)}". Atlas's response was wrong or inaccurate.`
      : `User indicated info is outdated: "${userMessage.slice(0, 300)}". Knowledge needs updating.`;

    // Record the learning
    await recordLearning(
      taskDescription,
      approach,
      'failure',
      reflection,
      undefined, // resolution will be filled when Atlas responds correctly
    );

    // Also record an audit log entry
    await query(
      `INSERT INTO audit_log (action_type, input_summary, output_summary, success, conversation_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        signal.type === 'correction' ? 'auto_correction_detected' : 'auto_staleness_detected',
        originalQuestion.slice(0, 200),
        JSON.stringify({
          signal,
          wrongResponse: previousResponse.slice(0, 200),
          correction: userMessage.slice(0, 300),
        }),
        false,
        conversationId,
      ]
    );

    logger.info('Auto-correction recorded', {
      type: signal.type,
      confidence: signal.confidence,
      conversationId,
    });
  } catch (err) {
    // Non-critical — don't fail the message processing
    logger.error('Failed to record auto-correction', { error: err });
  }
}

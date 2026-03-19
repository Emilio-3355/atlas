import { recordLearning } from '../memory/learnings.js';
import { upsertFact } from '../memory/structured.js';
import { callClaude, extractTextContent } from '../agent/claude-client.js';
import { query } from '../config/database.js';
import logger from '../utils/logger.js';

// Patterns that indicate the user is correcting Atlas
const CORRECTION_PATTERNS: RegExp[] = [
  // English corrections
  /\b(no[,.]?\s+(that'?s?\s+)?(wrong|incorrect|not\s+right|not\s+what))/i,
  /\b(actually[,.]?\s+(it'?s?|that'?s?|the)\s+(wrong|not|incorrect|different|called|supposed))/i,
  /\b(that'?s?\s+not\s+(correct|right|true|accurate|what\s+i|it|the))/i,
  /\b(you('?re|\s+are)\s+(wrong|mistaken|confused|incorrect))/i,
  /\b(i\s+(said|meant|asked\s+for|wanted)\s+.{2,}not\b)/i,
  /\b(not\s+that[,.]?\s+(i\s+mean|it'?s?|the))/i,
  /\b(wrong\s+(one|answer|info|information|number|date|time|name|place|links?|urls?|address|location|price|email))/i,
  /\b(correct(ion)?:\s+)/i,
  /\b(let\s+me\s+correct\s+(you|that))/i,
  /\b(i\s+never\s+(said|asked|told|wanted))/i,
  /\b(you\s+got\s+(it|that)\s+wrong)/i,
  /\b(nope[,.]?\s+(that'?s?\s+)?(wrong|not|incorrect))/i,
  /\b(try\s+again[,.]?\s+that'?s?\s+not)/i,

  // Spanish corrections
  /\b(no[,.]?\s+(eso\s+)?est[aá]n?\s+(mal|incorrecto|equivocado))/i,
  /\b(est[aá]n?\s+mal\b)/i,
  /\b(te\s+equivocas|est[aá]s\s+equivocado)/i,
  /\b(eso\s+no\s+es\s+(correcto|cierto|verdad|lo\s+que))/i,
  /\b(no\s+es\s+as[ií][,.]?\s+(busca|intenta|hazlo))/i,
  /\b(yo\s+(dije|ped[ií]|quer[ií]a)\s+.{2,}no\b)/i,
  /\b(correc(ci[oó]n|to):\s+)/i,
  /\b(no\s+me\s+(mandaste|diste|enviaste)\s+lo\s+que\s+(ped[ií]|quer[ií]a|busco))/i,
  /\b(no\s+(sirve|funciona|jala|abre)n?\b)/i,
  /\b(mal[,.]?\s+(intenta|busca|hazlo)\s+de\s+nuevo)/i,

  // Broken links / wrong URLs (EN + ES) — high frequency real-world pattern
  /\b(links?\s+(are\s+)?(broken|dead|wrong|roto|don'?t\s+work|doesn'?t\s+work))/i,
  /\b(links?\s+(no\s+)?(jala|funciona|sirve|abre)n?)/i,
  /\b(wrong\s+(urls?|links?))/i,
  /\b(url.{0,20}(404|broken|dead|doesn'?t\s+work|not\s+found))/i,
  /\b(toma\s+nota\s+de\s+(este|mi|el)\s+error)/i,
  /\b(hay\s+un\s+error)/i,
  /\b(link\s+est[aá]\s+(roto|mal|muerto))/i,
  /\b(links?\s+rotos?)/i,
];

// Patterns that indicate something is outdated — checked BEFORE corrections
// to avoid staleness being misclassified as correction
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

  // Check staleness FIRST to avoid misclassifying staleness as correction
  // (many staleness phrases like "that's outdated" also match correction patterns)
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

  return null;
}

/**
 * When a correction is detected, record a learning AND extract a behavioral rule
 * that gets stored as a memory fact for immediate and future use.
 * Returns the extracted rule text (if any) for injection into the current conversation.
 */
export async function handleCorrection(
  conversationId: string,
  userMessage: string,
  signal: CorrectionSignal,
): Promise<string | null> {
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

    // Extract a behavioral rule using Claude (fast, cheap call)
    let rule: string | null = null;
    try {
      rule = await extractBehavioralRule(originalQuestion, previousResponse, userMessage);
    } catch (err) {
      logger.debug('Rule extraction skipped', { error: err });
    }

    // Only record learning + store fact if we confirmed a real correction
    // (Claude returned a concrete rule, not "NONE"). This prevents false positives
    // like "Actually, that sounds great!" from polluting the learnings table.
    if (rule) {
      const taskDescription = signal.type === 'correction'
        ? `User corrected Atlas response to: "${originalQuestion.slice(0, 120)}"`
        : `User flagged outdated info in response to: "${originalQuestion.slice(0, 120)}"`;

      const approach = `Atlas responded: "${previousResponse.slice(0, 200)}"`;

      const reflection = signal.type === 'correction'
        ? `User correction: "${userMessage.slice(0, 300)}". Atlas's response was wrong or inaccurate.`
        : `User indicated info is outdated: "${userMessage.slice(0, 300)}". Knowledge needs updating.`;

      // Record the learning WITH the resolution (the rule)
      await recordLearning(
        taskDescription,
        approach,
        'failure',
        reflection,
        rule,
      );
      const ruleKey = `correction_rule_${Date.now()}`;
      await upsertFact(
        'behavioral_rule',
        ruleKey,
        rule,
        'correction_auto_extracted',
        0.9,
        {
          originalQuestion: originalQuestion.slice(0, 200),
          wrongResponse: previousResponse.slice(0, 100),
          correction: userMessage.slice(0, 200),
          extractedAt: new Date().toISOString(),
        },
      );
      logger.info('Behavioral rule stored', { ruleKey, rule: rule.slice(0, 100) });
    }

    // Audit log
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
          extractedRule: rule,
        }),
        false,
        conversationId,
      ]
    );

    logger.info('Auto-correction recorded', {
      type: signal.type,
      confidence: signal.confidence,
      ruleExtracted: !!rule,
      conversationId,
    });

    return rule;
  } catch (err) {
    logger.error('Failed to record auto-correction', { error: err });
    return null;
  }
}

/**
 * Use Claude to extract a concrete behavioral rule from a user correction.
 * This is a fast, single-turn call with no tools.
 */
async function extractBehavioralRule(
  originalQuestion: string,
  wrongResponse: string,
  correction: string,
): Promise<string | null> {
  const response = await callClaude({
    messages: [{
      role: 'user',
      content: `You are analyzing a correction from a user to extract a behavioral rule for an AI assistant.

ORIGINAL QUESTION: "${originalQuestion.slice(0, 300)}"
WRONG RESPONSE: "${wrongResponse.slice(0, 500)}"
USER CORRECTION: "${correction.slice(0, 500)}"

Extract ONE concrete, actionable rule that prevents this mistake in the future. The rule should be:
- Specific and actionable (not vague like "be more careful")
- Written as an instruction (e.g., "Always verify URLs return HTTP 200 before sending them" or "When recommending places, provide direct booking/class links, not just homepage URLs")
- Short (1-2 sentences max)

If the correction is too vague to extract a clear rule, respond with just "NONE".

Rule:`,
    }],
    system: 'You extract behavioral rules from user corrections. Be concise. Output only the rule text or "NONE".',
    depth: 'fast',
  });

  const text = extractTextContent(response.content)?.trim();
  if (!text || text === 'NONE' || text.length < 10 || text.length > 300) return null;
  return text;
}

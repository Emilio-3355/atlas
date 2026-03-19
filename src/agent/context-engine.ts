import { getAllFacts, searchFacts, getFactsByCategory } from '../memory/structured.js';
import { hybridSearch } from '../memory/semantic.js';
import { findRelevantLearnings } from '../memory/learnings.js';
import logger from '../utils/logger.js';

const MAX_MEMORY_TOKENS = 2000; // approximate cap for facts + semantic memory
const MAX_RULES_TOKENS = 1000;  // separate budget for behavioral rules — NEVER truncated with memory

interface ContextResult {
  memory: string;       // Facts + semantic memories (can be truncated)
  learnings: string;    // Past experience
  behavioralRules: string; // CRITICAL: extracted from corrections, NEVER truncated
}

export async function buildContext(userMessage: string): Promise<ContextResult> {
  const [structuredFacts, semanticResults, learnings, behavioralRules] = await Promise.allSettled([
    searchFacts(userMessage, 5),
    hybridSearch(userMessage, 5),
    findRelevantLearnings(userMessage, 3),
    getFactsByCategory('behavioral_rule'),
  ]);

  // === BEHAVIORAL RULES — separate from memory, NEVER truncated ===
  let rulesStr = '';
  if (behavioralRules.status === 'fulfilled' && behavioralRules.value.length > 0) {
    // Sort by most recent first (latest corrections take priority)
    const rules = behavioralRules.value.sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
    for (const rule of rules) {
      const line = `• ${rule.value}\n`;
      // Only cap at extreme lengths to prevent abuse, but never truncate mid-rule
      if (rulesStr.length + line.length > MAX_RULES_TOKENS * 4) break;
      rulesStr += line;
    }
    logger.debug('Loaded behavioral rules', { count: rules.length, chars: rulesStr.length });
  }

  // === MEMORY (facts + semantic) — can be truncated ===
  let memory = '';

  // Structured facts
  if (structuredFacts.status === 'fulfilled' && structuredFacts.value.length > 0) {
    memory += '*Known Facts:*\n';
    for (const fact of structuredFacts.value) {
      if (fact.category === 'behavioral_rule') continue; // Already in rules section
      memory += `• [${fact.category}] ${fact.key}: ${fact.value}\n`;
    }
  }

  // Semantic memories
  if (semanticResults.status === 'fulfilled' && semanticResults.value.length > 0) {
    memory += '\n*Related Memories:*\n';
    for (const mem of semanticResults.value) {
      memory += `• ${mem.content} (relevance: ${(mem.score * 100).toFixed(0)}%)\n`;
    }
  }

  // Trim memory (NOT rules) to token budget
  if (memory.length > MAX_MEMORY_TOKENS * 4) {
    memory = memory.slice(0, MAX_MEMORY_TOKENS * 4) + '\n...(memory truncated)';
  }

  // === LEARNINGS ===
  let learningsStr = '';
  if (learnings.status === 'fulfilled' && learnings.value.length > 0) {
    learningsStr = '*Past Experience:*\n';
    for (const l of learnings.value) {
      learningsStr += `• Task: ${l.taskDescription}\n  Outcome: ${l.outcome}`;
      if (l.resolution) learningsStr += `\n  Lesson: ${l.resolution}`;
      learningsStr += '\n';
    }
  }

  return { memory, learnings: learningsStr, behavioralRules: rulesStr };
}

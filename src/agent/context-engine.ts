import { getAllFacts, searchFacts, getFactsByCategory } from '../memory/structured.js';
import { hybridSearch } from '../memory/semantic.js';
import { findRelevantLearnings } from '../memory/learnings.js';
import { searchPastConversations } from '../memory/conversation.js';
import logger from '../utils/logger.js';

const MAX_MEMORY_TOKENS = 8000; // approximate cap for facts + semantic memory
const MAX_RULES_TOKENS = 3000;  // separate budget for behavioral rules — NEVER truncated with memory

interface ContextResult {
  memory: string;       // Facts + semantic memories (can be truncated)
  learnings: string;    // Past experience
  behavioralRules: string; // CRITICAL: extracted from corrections, NEVER truncated
}

export async function buildContext(userMessage: string, userPhone?: string): Promise<ContextResult> {
  const [structuredFacts, semanticResults, learnings, behavioralRules] = await Promise.allSettled([
    searchFacts(userMessage, 15),
    hybridSearch(userMessage, 15),
    findRelevantLearnings(userMessage, 8),
    getFactsByCategory('behavioral_rule'),
  ]);

  // CRITICAL: Log rejected promises so we know when memory is broken
  if (structuredFacts.status === 'rejected') {
    logger.error('MEMORY BROKEN: searchFacts failed', { error: structuredFacts.reason?.message || structuredFacts.reason });
  }
  if (semanticResults.status === 'rejected') {
    logger.warn('Semantic memory unavailable (embeddings may be misconfigured)', { error: semanticResults.reason?.message || semanticResults.reason });
  }
  if (learnings.status === 'rejected') {
    logger.error('MEMORY BROKEN: findRelevantLearnings failed', { error: learnings.reason?.message || learnings.reason });
  }
  if (behavioralRules.status === 'rejected') {
    logger.error('MEMORY BROKEN: getFactsByCategory(behavioral_rule) failed', { error: behavioralRules.reason?.message || behavioralRules.reason });
  }

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

  // === MEMORY (facts + semantic + past conversations) — can be truncated ===
  let memory = '';

  // Structured facts
  if (structuredFacts.status === 'fulfilled' && structuredFacts.value.length > 0) {
    memory += '*Known Facts:*\n';
    for (const fact of structuredFacts.value) {
      if (fact.category === 'behavioral_rule') continue; // Already in rules section
      memory += `• [${fact.category}] ${fact.key}: ${fact.value}\n`;
    }
  }

  // Semantic memories (with MMR dedup)
  if (semanticResults.status === 'fulfilled' && semanticResults.value.length > 0) {
    const deduped = applyMMR(semanticResults.value, 15);
    memory += '\n*Related Memories:*\n';
    for (const mem of deduped) {
      memory += `• ${mem.content} (relevance: ${(mem.score * 100).toFixed(0)}%)\n`;
    }
  }

  // Cross-conversation recall
  if (userPhone) {
    try {
      const pastConvos = await searchPastConversations(userPhone, userMessage, 3);
      if (pastConvos.length > 0) {
        memory += '\n*Past Conversations:*\n';
        for (const c of pastConvos) {
          memory += `• [${c.updated_at.toLocaleDateString()}] ${c.summary.slice(0, 500)}\n`;
        }
      }
    } catch (err) {
      logger.debug('Cross-conversation search failed', { error: err });
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

// === MMR (Maximal Marginal Relevance) Deduplication ===

interface ScoredItem {
  content: string;
  score: number;
  [key: string]: any;
}

/**
 * Filter results using MMR to remove near-duplicate memories.
 * Keeps the highest-scoring items that aren't >80% similar to already-selected ones.
 */
function applyMMR<T extends ScoredItem>(results: T[], limit: number): T[] {
  if (results.length <= limit) return results;

  const selected: T[] = [];
  const remaining = [...results];

  while (selected.length < limit && remaining.length > 0) {
    let picked = false;
    for (let i = 0; i < remaining.length; i++) {
      const isDuplicate = selected.some(s =>
        trigramSimilarity(s.content, remaining[i].content) > 0.8
      );
      if (!isDuplicate) {
        selected.push(remaining.splice(i, 1)[0]);
        picked = true;
        break;
      }
    }
    if (!picked) {
      // All remaining are duplicates of selected — take the highest-scored one anyway
      remaining.shift();
    }
  }

  return selected;
}

function trigramSimilarity(a: string, b: string): number {
  const triA = new Set(trigrams(a.toLowerCase()));
  const triB = new Set(trigrams(b.toLowerCase()));
  const intersection = [...triA].filter(t => triB.has(t)).length;
  return intersection / Math.max(triA.size, triB.size, 1);
}

function trigrams(s: string): string[] {
  const t: string[] = [];
  for (let i = 0; i <= s.length - 3; i++) t.push(s.slice(i, i + 3));
  return t;
}

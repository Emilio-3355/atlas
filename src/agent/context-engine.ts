import { getAllFacts, searchFacts, getFactsByCategory } from '../memory/structured.js';
import { hybridSearch } from '../memory/semantic.js';
import { findRelevantLearnings } from '../memory/learnings.js';
import logger from '../utils/logger.js';

const MAX_MEMORY_TOKENS = 2000; // approximate cap

interface ContextResult {
  memory: string;
  learnings: string;
}

export async function buildContext(userMessage: string): Promise<ContextResult> {
  const [structuredFacts, semanticResults, learnings, behavioralRules] = await Promise.allSettled([
    searchFacts(userMessage, 5),
    hybridSearch(userMessage, 5),
    findRelevantLearnings(userMessage, 3),
    getFactsByCategory('behavioral_rule'), // Always load ALL behavioral rules
  ]);

  let memory = '';

  // Behavioral rules — always included, these are critical corrections from JP
  if (behavioralRules.status === 'fulfilled' && behavioralRules.value.length > 0) {
    memory += '*Behavioral Rules (from JP corrections — ALWAYS follow these):*\n';
    for (const rule of behavioralRules.value) {
      memory += `• ${rule.value}\n`;
    }
  }

  // Structured facts
  if (structuredFacts.status === 'fulfilled' && structuredFacts.value.length > 0) {
    memory += '\n*Known Facts:*\n';
    for (const fact of structuredFacts.value) {
      // Skip behavioral rules here (already shown above)
      if (fact.category === 'behavioral_rule') continue;
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

  // Trim to token budget (rough estimate: 4 chars per token)
  if (memory.length > MAX_MEMORY_TOKENS * 4) {
    memory = memory.slice(0, MAX_MEMORY_TOKENS * 4) + '\n...(memory truncated)';
  }

  // Learnings
  let learningsStr = '';
  if (learnings.status === 'fulfilled' && learnings.value.length > 0) {
    learningsStr = '*Past Experience:*\n';
    for (const l of learnings.value) {
      learningsStr += `• Task: ${l.taskDescription}\n  Outcome: ${l.outcome}`;
      if (l.resolution) learningsStr += `\n  Lesson: ${l.resolution}`;
      learningsStr += '\n';
    }
  }

  return { memory, learnings: learningsStr };
}

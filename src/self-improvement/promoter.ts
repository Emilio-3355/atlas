import { query } from '../config/database.js';
import { upsertFact } from '../memory/structured.js';
import { storeSemanticMemory } from '../memory/semantic.js';
import logger from '../utils/logger.js';

const PROMOTION_THRESHOLD = 3; // Pattern must occur 3+ times to be promoted

// Graduate high-value learnings to permanent memory
export async function promoteLearnigs(): Promise<number> {
  let promoted = 0;

  // Find learnings with high pattern counts and resolutions
  const result = await query(
    `SELECT * FROM learnings
     WHERE outcome = 'success'
       AND resolution IS NOT NULL
       AND pattern_count >= $1
       AND resolved_at IS NOT NULL
       AND id NOT IN (
         SELECT (metadata->>'learning_id')::uuid FROM memory_facts
         WHERE metadata->>'type' = 'promoted_learning'
       )
     ORDER BY pattern_count DESC
     LIMIT 10`,
    [PROMOTION_THRESHOLD]
  );

  for (const learning of result.rows) {
    // Store as structured fact
    await upsertFact(
      'learning',
      `${learning.tool_name || 'general'}_${learning.pattern_hash}`,
      learning.resolution,
      'inferred',
      0.9,
      { type: 'promoted_learning', learning_id: learning.id },
    );

    // Store as semantic memory for similarity search
    await storeSemanticMemory(
      `Learned: when doing "${learning.task_description}", ${learning.resolution}`,
      'self_improvement',
      undefined,
      { learning_id: learning.id, pattern_count: learning.pattern_count },
    );

    promoted++;
    logger.info('Learning promoted to permanent memory', {
      id: learning.id,
      task: learning.task_description.slice(0, 50),
      patternCount: learning.pattern_count,
    });
  }

  return promoted;
}

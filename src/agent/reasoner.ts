import type { ReasoningDepth } from '../types/index.js';

// Keywords that indicate the user wants deeper reasoning
const DEEP_KEYWORDS = [
  /\b(compare|analyze|research|pros\s+and\s+cons|should\s+i|what\s+do\s+you\s+think|help\s+me\s+decide)\b/i,
  /\b(compara|analiza|investiga|qué\s+opinas|ayúdame\s+a\s+decidir)\b/i,
];

const EXPERT_KEYWORDS = [
  /\b(think\s+(deeply|carefully|hard)|important\s+decision|complex|strategic)\b/i,
  /\b(piensa\s+bien|decisión\s+importante|complejo|estratégico)\b/i,
];

// Tool chains that indicate complexity
const HIGH_ACTION_TOOLS = ['send_email', 'calendar_create', 'fill_form', 'book_reservation'];
const META_TOOLS = ['propose_tool', 'propose_workflow'];

export function determineDepth(
  message: string,
  toolChainLength: number = 0,
  toolsUsed: string[] = [],
  isRetry: boolean = false,
): ReasoningDepth {
  // Expert triggers
  if (EXPERT_KEYWORDS.some((re) => re.test(message))) return 'expert';
  if (toolsUsed.some((t) => META_TOOLS.includes(t))) return 'expert';

  // Deep triggers
  if (DEEP_KEYWORDS.some((re) => re.test(message))) return 'deep';
  if (toolsUsed.some((t) => HIGH_ACTION_TOOLS.includes(t))) return 'deep';
  if (toolChainLength >= 5) return 'deep';

  // Auto-escalation on retry
  if (isRetry) return 'deep';

  return 'fast';
}

export function escalateDepth(current: ReasoningDepth): ReasoningDepth {
  if (current === 'fast') return 'deep';
  if (current === 'deep') return 'expert';
  return 'expert';
}

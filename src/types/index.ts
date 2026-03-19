// ===== Core Types =====

export type TrustLevel = 'owner' | 'system' | 'semi-trusted' | 'untrusted' | 'hostile';

export type ReasoningDepth = 'fast' | 'deep' | 'expert';

export type ToolCategory = 'informational' | 'action' | 'sensitive';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'executed';

export type TaskScheduleType = 'one_shot' | 'recurring' | 'interval';

export type TaskDelivery = 'whatsapp' | 'telegram' | 'internal' | 'conditional';

export type MessageChannel = 'whatsapp' | 'telegram' | 'slack' | 'voice';

export interface ImageAttachment {
  /** Base64-encoded image data */
  base64: string;
  /** MIME type (image/jpeg, image/png, image/gif, image/webp) */
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
}

export type LearningOutcome = 'success' | 'failure' | 'partial';

// ===== Agent Types =====

export interface AgentMessage {
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result';
  content: string;
  toolName?: string;
  toolInput?: Record<string, any>;
  metadata?: Record<string, any>;
}

export interface AgentContext {
  conversationId: string;
  userPhone: string;
  language: string;
  channel: MessageChannel;
  recentMessages: AgentMessage[];
  relevantMemory: string;
  relevantLearnings: string;
  pendingActions: PendingAction[];
}

export interface AgentResponse {
  text: string;
  pendingActions?: PendingAction[];
  toolsUsed?: string[];
  reasoningDepth?: ReasoningDepth;
  tokensUsed?: number;
}

// ===== Tool Types =====

export interface ToolContext {
  conversationId: string;
  userPhone: string;
  language: string;
  channel: MessageChannel;
}

export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
  requiresApproval?: boolean;
  approvalPreview?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  category: ToolCategory;
  requiresApproval: boolean;
  inputSchema: Record<string, any>;
  execute: (input: any, ctx: ToolContext) => Promise<ToolResult>;
  formatApproval?: (input: any) => string;
  enabled: boolean;
  builtIn: boolean;
}

// ===== Memory Types =====

export interface MemoryFact {
  id: string;
  category: string;
  key: string;
  value: string;
  metadata: Record<string, any>;
  source: string;
  confidence: number;
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
}

export interface MemoryVector {
  id: string;
  content: string;
  metadata: Record<string, any>;
  source?: string;
  conversationId?: string;
  score?: number;
  createdAt: Date;
}

export interface Learning {
  id: string;
  taskDescription: string;
  approach: string;
  outcome: LearningOutcome;
  reflection?: string;
  resolution?: string;
  toolName?: string;
  patternHash?: string;
  patternCount: number;
  createdAt: Date;
  resolvedAt?: Date;
}

// ===== Action Types =====

export interface PendingAction {
  id: string;
  toolName: string;
  toolInput: Record<string, any>;
  previewText: string;
  conversationId?: string;
  status: ApprovalStatus;
  twilioMessageSid?: string;
  result?: Record<string, any>;
  createdAt: Date;
  expiresAt: Date;
  resolvedAt?: Date;
}

// ===== Workflow Types =====

export interface WorkflowStep {
  id: string;
  tool: string;
  input: Record<string, any>;
  requiresApproval: boolean;
  onError: 'stop' | 'skip' | 'retry' | 'alternative';
  alternative?: WorkflowStep;
  playByPlay?: string;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  triggerPattern?: string;
  steps: WorkflowStep[];
  status: string;
  usageCount: number;
  createdAt: Date;
}

// ===== Scheduler Types =====

export interface ScheduledTask {
  id: string;
  taskType: string;
  content: string;
  scheduleType: TaskScheduleType;
  scheduleValue: string;
  timezone: string;
  delivery: TaskDelivery;
  status: string;
  lastRunAt?: Date;
  nextRunAt?: Date;
  runCount: number;
  metadata: Record<string, any>;
  createdAt: Date;
}

// ===== Conversation Types =====

export interface Conversation {
  id: string;
  userPhone: string;
  status: string;
  summary?: string;
  messageCount: number;
  language: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Message {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  toolName?: string;
  toolInput?: Record<string, any>;
  metadata: Record<string, any>;
  createdAt: Date;
}

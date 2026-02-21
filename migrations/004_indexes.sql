-- Additional performance indexes (run after all tables created)

-- Composite indexes for common queries
CREATE INDEX IF NOT EXISTS idx_messages_role_conversation ON messages(conversation_id, role) WHERE role IN ('user', 'assistant');
CREATE INDEX IF NOT EXISTS idx_pending_actions_conversation ON pending_actions(conversation_id, status);
CREATE INDEX IF NOT EXISTS idx_memory_facts_key ON memory_facts(key);
CREATE INDEX IF NOT EXISTS idx_memory_facts_source ON memory_facts(source);
CREATE INDEX IF NOT EXISTS idx_tool_usage_success ON tool_usage(tool_name, success);
CREATE INDEX IF NOT EXISTS idx_learnings_outcome ON learnings(outcome);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_type ON scheduled_tasks(task_type, status);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC) WHERE status = 'active';

-- 009: Soft-delete messages instead of permanently deleting on compaction
ALTER TABLE messages ADD COLUMN IF NOT EXISTS compacted BOOLEAN DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_messages_compacted ON messages(conversation_id, compacted);

-- Enable pg_trgm for cross-conversation search (if not already enabled)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_conversations_summary_trgm ON conversations USING gin (summary gin_trgm_ops);

-- 008_workflow_patterns.sql: Foundry — workflow pattern tracking for auto-crystallization
CREATE TABLE IF NOT EXISTS workflow_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_sequence TEXT[] NOT NULL,
  input_summary TEXT,
  output_summary TEXT,
  success BOOLEAN NOT NULL DEFAULT true,
  conversation_id UUID REFERENCES conversations(id),
  pattern_hash VARCHAR(64),
  crystallized BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wp_hash ON workflow_patterns(pattern_hash);
CREATE INDEX IF NOT EXISTS idx_wp_created ON workflow_patterns(created_at);
CREATE INDEX IF NOT EXISTS idx_wp_sequence ON workflow_patterns USING gin(tool_sequence);

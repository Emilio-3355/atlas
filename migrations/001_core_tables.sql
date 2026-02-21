-- Atlas Core Tables (Phase 1)

-- Conversations
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_phone VARCHAR(50) NOT NULL,
  status VARCHAR(20) DEFAULT 'active',
  summary TEXT,
  message_count INTEGER DEFAULT 0,
  language VARCHAR(5) DEFAULT 'en',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Individual messages
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL,
  content TEXT NOT NULL,
  tool_name VARCHAR(100),
  tool_input JSONB,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Structured memory (facts, preferences, contacts)
CREATE TABLE IF NOT EXISTS memory_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category VARCHAR(50) NOT NULL,
  key VARCHAR(200) NOT NULL,
  value TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  source VARCHAR(50) DEFAULT 'jp_told',
  confidence FLOAT DEFAULT 1.0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  UNIQUE(category, key)
);

-- Pending actions (approval pipeline)
CREATE TABLE IF NOT EXISTS pending_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_name VARCHAR(100) NOT NULL,
  tool_input JSONB NOT NULL,
  preview_text TEXT NOT NULL,
  conversation_id UUID REFERENCES conversations(id),
  status VARCHAR(20) DEFAULT 'pending',
  twilio_message_sid VARCHAR(100),
  result JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 minutes',
  resolved_at TIMESTAMPTZ
);

-- Scheduled tasks
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_type VARCHAR(50) NOT NULL,
  content TEXT NOT NULL,
  schedule_type VARCHAR(20) NOT NULL,
  schedule_value VARCHAR(100) NOT NULL,
  timezone VARCHAR(50) DEFAULT 'America/New_York',
  delivery VARCHAR(20) DEFAULT 'whatsapp',
  status VARCHAR(20) DEFAULT 'active',
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  run_count INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tool usage tracking
CREATE TABLE IF NOT EXISTS tool_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_name VARCHAR(100) NOT NULL,
  input_summary TEXT,
  success BOOLEAN NOT NULL,
  duration_ms INTEGER,
  error_message TEXT,
  conversation_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Contacts
CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  email VARCHAR(255),
  relationship VARCHAR(100),
  notes TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Full audit log
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type VARCHAR(50) NOT NULL,
  tool_name VARCHAR(100),
  input_summary TEXT,
  output_summary TEXT,
  success BOOLEAN,
  error_message TEXT,
  approval_status VARCHAR(20),
  conversation_id UUID,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_phone, status);
CREATE INDEX IF NOT EXISTS idx_memory_facts_category ON memory_facts(category);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next ON scheduled_tasks(next_run_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_pending_actions_status ON pending_actions(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_tool_usage_tool ON tool_usage(tool_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);

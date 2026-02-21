-- Atlas Self-Improvement (Phase 5)

-- Dynamic tool definitions (JP-approved custom tools)
CREATE TABLE IF NOT EXISTS tool_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) UNIQUE NOT NULL,
  description TEXT NOT NULL,
  input_schema JSONB NOT NULL,
  implementation_type VARCHAR(50),
  implementation JSONB,
  status VARCHAR(20) DEFAULT 'proposed',
  rationale TEXT,
  usage_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  proposed_at TIMESTAMPTZ DEFAULT NOW(),
  approved_at TIMESTAMPTZ
);

-- Workflow definitions (reusable multi-step workflows)
CREATE TABLE IF NOT EXISTS workflow_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  trigger_pattern TEXT,
  steps JSONB NOT NULL,
  status VARCHAR(20) DEFAULT 'proposed',
  usage_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

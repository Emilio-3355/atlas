-- Atlas Memory (Phase 2) — pgvector-free (JSONB embeddings, cosine similarity in-app)

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Semantic memory (JSONB embeddings — cosine similarity computed in application)
CREATE TABLE IF NOT EXISTS memory_vectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  embedding JSONB,
  metadata JSONB DEFAULT '{}',
  source VARCHAR(50),
  conversation_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Learnings (Reflexion memory)
CREATE TABLE IF NOT EXISTS learnings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_description TEXT NOT NULL,
  approach TEXT NOT NULL,
  outcome VARCHAR(20) NOT NULL,
  reflection TEXT,
  resolution TEXT,
  tool_name VARCHAR(100),
  pattern_hash VARCHAR(64),
  pattern_count INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

-- Indexes (no HNSW — similarity computed in-app)
CREATE INDEX IF NOT EXISTS idx_memory_facts_trgm ON memory_facts USING gin (value gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_memory_vectors_content_trgm ON memory_vectors USING gin (content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_learnings_pattern ON learnings(pattern_hash);

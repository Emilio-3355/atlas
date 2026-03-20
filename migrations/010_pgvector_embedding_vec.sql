-- 010: Add native vector column for pgvector DB-side similarity search
-- Falls back gracefully if pgvector extension is not available
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE memory_vectors ADD COLUMN IF NOT EXISTS embedding_vec vector(1536);
CREATE INDEX IF NOT EXISTS idx_memory_vectors_hnsw ON memory_vectors USING hnsw (embedding_vec vector_cosine_ops);

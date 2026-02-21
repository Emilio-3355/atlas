-- Atlas Safe Evolution System (Phase 5b)
-- Immutable audit trail + evolution state tracking

-- Evolution events — immutable, append-only audit log of every evolution cycle
CREATE TABLE IF NOT EXISTS evolution_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_number INTEGER NOT NULL,
  intent VARCHAR(20) NOT NULL CHECK (intent IN ('repair', 'optimize', 'innovate')),
  signals JSONB NOT NULL DEFAULT '[]',
  proposals JSONB NOT NULL DEFAULT '[]',
  approved_proposals JSONB DEFAULT '[]',
  outcome VARCHAR(20) NOT NULL CHECK (outcome IN ('no_proposals', 'proposed', 'approved', 'rejected', 'skipped', 'error')),
  stats_snapshot JSONB NOT NULL DEFAULT '{}',
  staleness_report TEXT,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Evolution state — tracks circuit breaker, strategy, cycle count
CREATE TABLE IF NOT EXISTS evolution_state (
  key VARCHAR(100) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Initialize evolution state
INSERT INTO evolution_state (key, value) VALUES
  ('cycle_count', '0'),
  ('strategy', '"balanced"'),
  ('consecutive_repairs', '0'),
  ('last_successful_cycle', 'null'),
  ('circuit_breaker_tripped', 'false')
ON CONFLICT (key) DO NOTHING;

-- Index for fast audit queries
CREATE INDEX IF NOT EXISTS idx_evolution_events_created ON evolution_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_evolution_events_intent ON evolution_events (intent);

-- Atlas Financial Intelligence Suite (Phase 6)
-- Stock watchlist, SEC filing monitoring, and alert history

-- Stock price watchlist — tracks tickers with configurable alert conditions
CREATE TABLE IF NOT EXISTS stock_watchlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker VARCHAR(10) NOT NULL,
  company_name VARCHAR(255),
  alert_type VARCHAR(20) NOT NULL CHECK (alert_type IN ('drop_pct', 'rise_pct', 'below_price', 'above_price')),
  threshold NUMERIC(12, 4) NOT NULL,
  reference_price NUMERIC(12, 4),
  current_price NUMERIC(12, 4),
  rearm BOOLEAN NOT NULL DEFAULT false,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'triggered', 'paused', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  triggered_at TIMESTAMPTZ
);

-- SEC filing watchlist — monitors companies for new filings
CREATE TABLE IF NOT EXISTS sec_watchlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker VARCHAR(10) NOT NULL,
  company_name VARCHAR(255),
  cik VARCHAR(20) NOT NULL,
  filing_types TEXT[] NOT NULL DEFAULT ARRAY['10-K', '10-Q', '8-K'],
  last_checked_at TIMESTAMPTZ,
  last_filing_date DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(cik)
);

-- Price alert history — log of triggered stock alerts
CREATE TABLE IF NOT EXISTS price_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  watchlist_id UUID NOT NULL REFERENCES stock_watchlist(id) ON DELETE CASCADE,
  ticker VARCHAR(10) NOT NULL,
  alert_type VARCHAR(20) NOT NULL,
  reference_price NUMERIC(12, 4),
  triggered_price NUMERIC(12, 4) NOT NULL,
  threshold NUMERIC(12, 4) NOT NULL,
  change_pct NUMERIC(8, 4),
  message_sent BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Filing alert history — log of detected new filings
CREATE TABLE IF NOT EXISTS filing_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sec_watchlist_id UUID NOT NULL REFERENCES sec_watchlist(id) ON DELETE CASCADE,
  ticker VARCHAR(10) NOT NULL,
  filing_type VARCHAR(20) NOT NULL,
  accession_number VARCHAR(50) NOT NULL,
  filing_date DATE,
  filing_url TEXT,
  description TEXT,
  message_sent BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_stock_watchlist_status ON stock_watchlist (status);
CREATE INDEX IF NOT EXISTS idx_stock_watchlist_ticker ON stock_watchlist (ticker);
CREATE INDEX IF NOT EXISTS idx_stock_watchlist_created ON stock_watchlist (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sec_watchlist_status ON sec_watchlist (status);
CREATE INDEX IF NOT EXISTS idx_sec_watchlist_cik ON sec_watchlist (cik);
CREATE INDEX IF NOT EXISTS idx_sec_watchlist_created ON sec_watchlist (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_price_alerts_watchlist ON price_alerts (watchlist_id);
CREATE INDEX IF NOT EXISTS idx_price_alerts_created ON price_alerts (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_filing_alerts_watchlist ON filing_alerts (sec_watchlist_id);
CREATE INDEX IF NOT EXISTS idx_filing_alerts_created ON filing_alerts (created_at DESC);

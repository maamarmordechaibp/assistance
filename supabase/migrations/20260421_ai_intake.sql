-- ============================================================
-- Migration 20260421: AI Intake, Call Findings, Extended Analyses
-- ============================================================

-- ── 1. calls: AI intake fields ──
ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS ai_intake_brief      JSONB,
  ADD COLUMN IF NOT EXISTS ai_intake_completed  BOOLEAN NOT NULL DEFAULT false;

-- ── 2. customers: preference profile (auto-updated by ai-analyze) ──
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}';

-- ── 3. reps: specialties for skill-based routing ──
ALTER TABLE reps
  ADD COLUMN IF NOT EXISTS specialties TEXT[] NOT NULL DEFAULT '{}';

-- ── 4. call_findings: items / links found during calls ──
CREATE TABLE IF NOT EXISTS call_findings (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id       UUID        REFERENCES calls(id)     ON DELETE SET NULL,
  customer_id   UUID        REFERENCES customers(id) ON DELETE SET NULL,
  rep_id        UUID        REFERENCES reps(id)      ON DELETE SET NULL,
  description   TEXT        NOT NULL,
  item_url      TEXT,
  item_price    TEXT,
  item_platform TEXT,
  item_notes    TEXT,
  search_terms  TEXT[]      NOT NULL DEFAULT '{}',
  -- 'manual' = rep logged it  |  'ai_auto' = extracted by ai-analyze
  source        TEXT        NOT NULL DEFAULT 'manual',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Full-text search index so sw-ai-intake can match past findings quickly
CREATE INDEX IF NOT EXISTS idx_call_findings_description_fts
  ON call_findings USING gin(to_tsvector('english', description));

CREATE INDEX IF NOT EXISTS idx_call_findings_created_at
  ON call_findings (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_call_findings_customer_id
  ON call_findings (customer_id);

ALTER TABLE call_findings ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_all_call_findings
  ON call_findings FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY authenticated_read_call_findings
  ON call_findings FOR SELECT TO authenticated
  USING (true);

-- ── 5. call_analyses: item extraction fields ──
ALTER TABLE call_analyses
  ADD COLUMN IF NOT EXISTS item_found         BOOLEAN  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS item_description   TEXT,
  ADD COLUMN IF NOT EXISTS item_price         TEXT,
  ADD COLUMN IF NOT EXISTS item_url           TEXT,
  ADD COLUMN IF NOT EXISTS item_platform      TEXT,
  ADD COLUMN IF NOT EXISTS item_notes         TEXT,
  ADD COLUMN IF NOT EXISTS item_search_terms  TEXT[]   NOT NULL DEFAULT '{}';

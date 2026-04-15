-- ============================================
-- 005: Call analyses (AI output)
-- ============================================

CREATE TYPE ai_success_status AS ENUM ('successful', 'partially_successful', 'unsuccessful');
CREATE TYPE ai_sentiment AS ENUM ('positive', 'neutral', 'negative');

CREATE TABLE call_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id UUID NOT NULL UNIQUE REFERENCES calls(id) ON DELETE CASCADE,
  ai_summary TEXT,
  ai_category TEXT,
  ai_success_status ai_success_status,
  ai_sentiment ai_sentiment,
  ai_followup_needed BOOLEAN DEFAULT false,
  ai_wasted_time_flag BOOLEAN DEFAULT false,
  ai_flag_reason TEXT,
  ai_confidence_score NUMERIC(3,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_call_analyses_call_id ON call_analyses (call_id);

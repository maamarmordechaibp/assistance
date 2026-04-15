-- ============================================
-- 004: Calls table
-- ============================================

CREATE TYPE call_outcome AS ENUM ('resolved', 'unresolved', 'partial');
CREATE TYPE call_flag_status AS ENUM ('none', 'flagged', 'reviewed', 'dismissed');

CREATE TABLE calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  rep_id UUID REFERENCES reps(id) ON DELETE SET NULL,
  inbound_phone TEXT,
  call_sid TEXT UNIQUE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  connected_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  total_duration_seconds INT,
  billable_duration_seconds INT,
  minutes_deducted NUMERIC(10,2) DEFAULT 0,
  recording_url TEXT,
  recording_storage_path TEXT,
  transcript_text TEXT,
  rep_notes TEXT,
  task_category_id UUID REFERENCES task_categories(id) ON DELETE SET NULL,
  outcome_status call_outcome,
  followup_needed BOOLEAN DEFAULT false,
  flag_status call_flag_status NOT NULL DEFAULT 'none',
  flag_reason TEXT,
  extensions_used INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_calls_customer_id ON calls (customer_id);
CREATE INDEX idx_calls_rep_id ON calls (rep_id);
CREATE INDEX idx_calls_started_at ON calls (started_at DESC);
CREATE INDEX idx_calls_call_sid ON calls (call_sid) WHERE call_sid IS NOT NULL;
CREATE INDEX idx_calls_flag_status ON calls (flag_status) WHERE flag_status = 'flagged';

-- ============================================
-- 20260429000003: Rep time tracking, auto-status, missed-call alerts,
--                 and post-call rep questionnaire (call_outcomes).
-- ============================================
-- Adds:
--   * rep_sessions          (clock in/out for payroll)
--   * rep_status_events     (audit trail of every status change)
--   * missed_calls          (rep was available but didn't answer in time)
--   * admin_alerts          (in-app banner + email notifications)
--   * call_outcomes         (rep's post-call questionnaire)
--   * rep_status enum value 'wrap_up'
-- ============================================

-- ----- rep_status: add wrap_up -----
DO $$ BEGIN
  ALTER TYPE rep_status ADD VALUE IF NOT EXISTS 'wrap_up';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================
-- rep_sessions: one row per shift (clock-in -> clock-out).
-- Only one open session per rep at a time.
-- ============================================
CREATE TABLE IF NOT EXISTS rep_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id UUID NOT NULL REFERENCES reps(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  end_reason TEXT CHECK (end_reason IN ('manual','idle_timeout','admin_force','crash')),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  total_active_seconds INT,
  total_call_seconds INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rep_sessions_rep_started
  ON rep_sessions (rep_id, started_at DESC);

-- One open shift per rep
CREATE UNIQUE INDEX IF NOT EXISTS uq_rep_sessions_one_open_per_rep
  ON rep_sessions (rep_id) WHERE ended_at IS NULL;

ALTER TABLE rep_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY rep_sessions_admin_all ON rep_sessions
  FOR ALL TO authenticated
  USING (public.user_role() = 'admin')
  WITH CHECK (public.user_role() = 'admin');

-- Reps can read their own sessions
CREATE POLICY rep_sessions_rep_read_own ON rep_sessions
  FOR SELECT TO authenticated
  USING (public.user_role() = 'rep' AND rep_id = auth.uid());

-- Reps can update last_heartbeat_at on their own open session
-- (start/end go through the rep-shift edge function for atomicity)
CREATE POLICY rep_sessions_rep_heartbeat ON rep_sessions
  FOR UPDATE TO authenticated
  USING (public.user_role() = 'rep' AND rep_id = auth.uid() AND ended_at IS NULL)
  WITH CHECK (public.user_role() = 'rep' AND rep_id = auth.uid() AND ended_at IS NULL);

CREATE POLICY rep_sessions_service_all ON rep_sessions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Realtime so admin board updates live
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE rep_sessions;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================
-- rep_status_events: append-only audit of every status change.
-- ============================================
CREATE TABLE IF NOT EXISTS rep_status_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id UUID NOT NULL REFERENCES reps(id) ON DELETE CASCADE,
  from_status rep_status,
  to_status rep_status NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN (
    'manual','call_claimed','call_ended','outcome_submitted',
    'idle_warning','idle_logout','admin_force','shift_start','shift_end','wrap_up_timeout'
  )),
  call_id UUID REFERENCES calls(id) ON DELETE SET NULL,
  session_id UUID REFERENCES rep_sessions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rep_status_events_rep_created
  ON rep_status_events (rep_id, created_at DESC);

ALTER TABLE rep_status_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY rep_status_events_admin_all ON rep_status_events
  FOR ALL TO authenticated
  USING (public.user_role() = 'admin')
  WITH CHECK (public.user_role() = 'admin');

CREATE POLICY rep_status_events_rep_read_own ON rep_status_events
  FOR SELECT TO authenticated
  USING (public.user_role() = 'rep' AND rep_id = auth.uid());

CREATE POLICY rep_status_events_service_all ON rep_status_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE rep_status_events;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================
-- missed_calls: a call rang to an available rep and was not answered in time.
-- ============================================
CREATE TABLE IF NOT EXISTS missed_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_queue_id UUID REFERENCES call_queue(id) ON DELETE SET NULL,
  rep_id UUID REFERENCES reps(id) ON DELETE SET NULL,   -- targeted rep, if any
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  rang_seconds INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  acknowledged_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_missed_calls_created ON missed_calls (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_missed_calls_unack
  ON missed_calls (created_at DESC) WHERE acknowledged_at IS NULL;
-- Prevent duplicate insertions for the same queue row
CREATE UNIQUE INDEX IF NOT EXISTS uq_missed_calls_queue ON missed_calls (call_queue_id)
  WHERE call_queue_id IS NOT NULL;

ALTER TABLE missed_calls ENABLE ROW LEVEL SECURITY;

CREATE POLICY missed_calls_admin_all ON missed_calls
  FOR ALL TO authenticated
  USING (public.user_role() = 'admin')
  WITH CHECK (public.user_role() = 'admin');

CREATE POLICY missed_calls_service_all ON missed_calls
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================
-- admin_alerts: generic in-app + email alert queue for admins.
-- ============================================
CREATE TABLE IF NOT EXISTS admin_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('missed_call','rep_idle','rep_no_answer','rep_force_logout')),
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_at TIMESTAMPTZ,
  seen_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  email_sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_alerts_unseen
  ON admin_alerts (created_at DESC) WHERE seen_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_admin_alerts_kind_created
  ON admin_alerts (kind, created_at DESC);

ALTER TABLE admin_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_alerts_admin_all ON admin_alerts
  FOR ALL TO authenticated
  USING (public.user_role() = 'admin')
  WITH CHECK (public.user_role() = 'admin');

CREATE POLICY admin_alerts_service_all ON admin_alerts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE admin_alerts;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================
-- call_outcomes: rep's post-call questionnaire (one row per call).
-- ============================================
CREATE TABLE IF NOT EXISTS call_outcomes (
  call_id UUID PRIMARY KEY REFERENCES calls(id) ON DELETE CASCADE,
  rep_id UUID REFERENCES reps(id) ON DELETE SET NULL,
  resolved TEXT CHECK (resolved IN ('yes','no','partial')),
  task_category_id UUID REFERENCES task_categories(id) ON DELETE SET NULL,
  order_placed BOOLEAN NOT NULL DEFAULT false,
  order_id TEXT,
  payment_taken BOOLEAN NOT NULL DEFAULT false,
  payment_amount_cents INT,
  callback_needed BOOLEAN NOT NULL DEFAULT false,
  callback_at TIMESTAMPTZ,
  notes TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  auto_submitted BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_call_outcomes_rep ON call_outcomes (rep_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_outcomes_category ON call_outcomes (task_category_id);

ALTER TABLE call_outcomes ENABLE ROW LEVEL SECURITY;

CREATE POLICY call_outcomes_admin_all ON call_outcomes
  FOR ALL TO authenticated
  USING (public.user_role() = 'admin')
  WITH CHECK (public.user_role() = 'admin');

-- Reps can read all outcomes (for customer history) but only insert/update their own
CREATE POLICY call_outcomes_rep_read ON call_outcomes
  FOR SELECT TO authenticated
  USING (public.user_role() = 'rep');

CREATE POLICY call_outcomes_rep_insert_own ON call_outcomes
  FOR INSERT TO authenticated
  WITH CHECK (public.user_role() = 'rep' AND rep_id = auth.uid());

CREATE POLICY call_outcomes_rep_update_own ON call_outcomes
  FOR UPDATE TO authenticated
  USING (public.user_role() = 'rep' AND rep_id = auth.uid())
  WITH CHECK (public.user_role() = 'rep' AND rep_id = auth.uid());

CREATE POLICY call_outcomes_service_all ON call_outcomes
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================
-- Settings flags (used by rep-monitor and rep dashboard)
-- ============================================
INSERT INTO admin_settings (key, value, description) VALUES
  ('rep_idle_timeout_seconds', '600', 'Auto-logout rep after this many seconds of inactivity'),
  ('rep_idle_warning_seconds', '540', 'Show idle warning modal after this many seconds (60s before logout)'),
  ('missed_call_threshold_seconds', '30', 'Alert admin if call rings to available rep this long unanswered'),
  ('wrap_up_grace_seconds', '60', 'Soft block after call before auto-submit blank outcome'),
  ('admin_alert_email_throttle_seconds', '300', 'Min seconds between admin alert emails of same kind')
ON CONFLICT (key) DO NOTHING;

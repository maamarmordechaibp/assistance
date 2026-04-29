-- ============================================
-- 20260429000005: Behavior moderation, rep skill profile, smart routing
-- ============================================
-- Adds:
--   * call_behavior_flags     (AI-detected inappropriate rep behavior)
--   * rep_skill_stats         (materialized view: avg duration & count per rep+category)
--   * admin_phone_alerts      (queue of admin phone-call alerts)
--   * settings keys for behavior moderation + admin phone numbers
-- ============================================

-- ----- call_behavior_flags ----------------------------------------------
-- Per-call findings from the AI behavior moderator. One call may have many
-- flags (e.g. "inappropriate_language" + "raised_voice"). Each flag has a
-- severity. Critical flags trigger an immediate admin phone-call.
CREATE TABLE IF NOT EXISTS call_behavior_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  rep_id UUID REFERENCES reps(id) ON DELETE SET NULL,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  category TEXT NOT NULL CHECK (category IN (
    'inappropriate_language',
    'raised_voice',
    'religious_or_political',
    'discriminatory',
    'harassment',
    'threats_or_violence',
    'unprofessional',
    'other'
  )),
  severity TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info','warning','critical')),
  excerpt TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_behavior_flags_rep_created
  ON call_behavior_flags (rep_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_behavior_flags_call
  ON call_behavior_flags (call_id);
CREATE INDEX IF NOT EXISTS idx_behavior_flags_severity
  ON call_behavior_flags (severity, created_at DESC);

ALTER TABLE call_behavior_flags ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS behavior_flags_admin_all ON call_behavior_flags;
CREATE POLICY behavior_flags_admin_all ON call_behavior_flags
  FOR ALL TO authenticated
  USING (public.user_role() = 'admin')
  WITH CHECK (public.user_role() = 'admin');
DROP POLICY IF EXISTS behavior_flags_service_all ON call_behavior_flags;
CREATE POLICY behavior_flags_service_all ON call_behavior_flags
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE call_behavior_flags;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ----- admin_phone_alerts -----------------------------------------------
-- Queue of pending admin phone calls. The rep-monitor (or ai-analyze) inserts
-- a row; a dedicated function (or pg_cron) places the call via SignalWire.
CREATE TABLE IF NOT EXISTS admin_phone_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reason TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  call_id UUID REFERENCES calls(id) ON DELETE SET NULL,
  rep_id UUID REFERENCES reps(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','dialing','completed','failed','skipped')),
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dialed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_admin_phone_alerts_pending
  ON admin_phone_alerts (created_at DESC) WHERE status = 'pending';

ALTER TABLE admin_phone_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS phone_alerts_admin_all ON admin_phone_alerts;
CREATE POLICY phone_alerts_admin_all ON admin_phone_alerts
  FOR ALL TO authenticated
  USING (public.user_role() = 'admin')
  WITH CHECK (public.user_role() = 'admin');
DROP POLICY IF EXISTS phone_alerts_service_all ON admin_phone_alerts;
CREATE POLICY phone_alerts_service_all ON admin_phone_alerts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ----- rep_skill_stats view ---------------------------------------------
-- Per-rep, per-category roll-up used for: efficiency dashboards, smart
-- routing, and rep detail pages. Refreshed live (regular view, not
-- materialized) so it always reflects the latest data.
--
-- Sources:
--   * calls.task_category_id  -> bucket
--   * call_outcomes.resolved  -> success rate
--   * customer_feedback       -> avg satisfaction
CREATE OR REPLACE VIEW rep_skill_stats AS
SELECT
  c.rep_id,
  c.task_category_id,
  COUNT(*)::INT                                             AS call_count,
  COALESCE(AVG(NULLIF(c.total_duration_seconds, 0)), 0)::INT AS avg_duration_seconds,
  COALESCE(
    AVG(CASE WHEN co.resolved = 'yes' THEN 1.0
             WHEN co.resolved = 'partial' THEN 0.5
             WHEN co.resolved = 'no' THEN 0.0 END),
    NULL
  )::NUMERIC(4,3) AS resolution_rate,
  COALESCE(AVG(cf.rating), NULL)::NUMERIC(4,2) AS avg_rating,
  COUNT(cf.id)::INT AS feedback_count,
  MAX(c.ended_at) AS last_call_at
FROM calls c
LEFT JOIN call_outcomes co ON co.call_id = c.id
LEFT JOIN customer_feedback cf ON cf.call_id = c.id
WHERE c.rep_id IS NOT NULL
  AND c.task_category_id IS NOT NULL
  AND c.ended_at IS NOT NULL
GROUP BY c.rep_id, c.task_category_id;

GRANT SELECT ON rep_skill_stats TO authenticated;

-- ----- rep_summary view -------------------------------------------------
-- Per-rep summary used on the admin reps board and rep detail page.
CREATE OR REPLACE VIEW rep_summary AS
SELECT
  r.id,
  r.full_name,
  r.email,
  r.status,
  COUNT(DISTINCT c.id) FILTER (WHERE c.ended_at IS NOT NULL)::INT AS total_calls,
  COALESCE(AVG(NULLIF(c.total_duration_seconds, 0)), 0)::INT       AS avg_call_seconds,
  COALESCE(SUM(c.total_duration_seconds), 0)::BIGINT               AS total_call_seconds,
  COALESCE(AVG(cf.rating), NULL)::NUMERIC(4,2)                     AS avg_rating,
  COUNT(cf.id)::INT                                                AS feedback_count,
  COUNT(DISTINCT cbf.id)::INT                                      AS behavior_flag_count,
  COUNT(DISTINCT cbf.id) FILTER (WHERE cbf.severity = 'critical')::INT AS critical_flag_count
FROM reps r
LEFT JOIN calls c ON c.rep_id = r.id
LEFT JOIN customer_feedback cf ON cf.rep_id = r.id
LEFT JOIN call_behavior_flags cbf ON cbf.rep_id = r.id
GROUP BY r.id;

GRANT SELECT ON rep_summary TO authenticated;

-- ----- Extend admin_alerts.kind to include behavior_critical -----------
ALTER TABLE admin_alerts DROP CONSTRAINT IF EXISTS admin_alerts_kind_check;
ALTER TABLE admin_alerts ADD CONSTRAINT admin_alerts_kind_check
  CHECK (kind IN ('missed_call','rep_idle','rep_no_answer','rep_force_logout','behavior_critical'));

-- ----- Settings ---------------------------------------------------------
INSERT INTO admin_settings (key, value, description) VALUES
  ('admin_phone_numbers', '[]'::jsonb, 'JSON array of admin phone numbers (E.164) to call on critical alerts'),
  ('admin_phone_alert_throttle_seconds', '600', 'Min seconds between admin phone alerts of same reason'),
  ('behavior_moderation_enabled', 'true'::jsonb, 'Run AI behavior moderation on completed calls'),
  ('smart_routing_enabled', 'false'::jsonb, 'Prefer reps with fastest avg time in detected category for inbound routing')
ON CONFLICT (key) DO NOTHING;

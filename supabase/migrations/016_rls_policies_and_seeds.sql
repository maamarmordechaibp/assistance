-- ============================================
-- 016: RLS Policies + Seed Data
-- ============================================

-- ============================================
-- Enable RLS on all tables
-- ============================================

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE reps ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE minute_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_benchmarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE callback_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE disclosure_prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;

-- ============================================
-- Helper function: get user role from JWT
-- ============================================

CREATE OR REPLACE FUNCTION public.user_role()
RETURNS TEXT AS $$
  SELECT coalesce(
    current_setting('request.jwt.claims', true)::json->>'role',
    (current_setting('request.jwt.claims', true)::json->'app_metadata'->>'role')
  );
$$ LANGUAGE sql STABLE;

-- ============================================
-- Policies: customers
-- ============================================

-- Admins: full access
CREATE POLICY admin_all_customers ON customers
  FOR ALL TO authenticated
  USING (public.user_role() = 'admin')
  WITH CHECK (public.user_role() = 'admin');

-- Reps: read-only
CREATE POLICY rep_read_customers ON customers
  FOR SELECT TO authenticated
  USING (public.user_role() = 'rep');

-- Reps: can insert new customers
CREATE POLICY rep_insert_customers ON customers
  FOR INSERT TO authenticated
  WITH CHECK (public.user_role() = 'rep');

-- Service role bypass (for webhooks)
CREATE POLICY service_all_customers ON customers
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================
-- Policies: reps
-- ============================================

CREATE POLICY admin_all_reps ON reps
  FOR ALL TO authenticated
  USING (public.user_role() = 'admin')
  WITH CHECK (public.user_role() = 'admin');

-- Reps: can read all reps, update own record
CREATE POLICY rep_read_reps ON reps
  FOR SELECT TO authenticated
  USING (public.user_role() = 'rep');

CREATE POLICY rep_update_own ON reps
  FOR UPDATE TO authenticated
  USING (public.user_role() = 'rep' AND id = auth.uid())
  WITH CHECK (public.user_role() = 'rep' AND id = auth.uid());

CREATE POLICY service_all_reps ON reps
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================
-- Policies: calls
-- ============================================

CREATE POLICY admin_all_calls ON calls
  FOR ALL TO authenticated
  USING (public.user_role() = 'admin')
  WITH CHECK (public.user_role() = 'admin');

-- Reps: read all calls (for customer history), update own calls
CREATE POLICY rep_read_calls ON calls
  FOR SELECT TO authenticated
  USING (public.user_role() = 'rep');

CREATE POLICY rep_update_own_calls ON calls
  FOR UPDATE TO authenticated
  USING (public.user_role() = 'rep' AND rep_id = auth.uid())
  WITH CHECK (public.user_role() = 'rep' AND rep_id = auth.uid());

CREATE POLICY service_all_calls ON calls
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================
-- Policies: call_analyses
-- ============================================

CREATE POLICY admin_all_analyses ON call_analyses
  FOR ALL TO authenticated
  USING (public.user_role() = 'admin')
  WITH CHECK (public.user_role() = 'admin');

CREATE POLICY rep_read_analyses ON call_analyses
  FOR SELECT TO authenticated
  USING (public.user_role() = 'rep');

CREATE POLICY service_all_analyses ON call_analyses
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================
-- Policies: minute_ledger
-- ============================================

CREATE POLICY admin_all_ledger ON minute_ledger
  FOR ALL TO authenticated
  USING (public.user_role() = 'admin')
  WITH CHECK (public.user_role() = 'admin');

CREATE POLICY rep_read_ledger ON minute_ledger
  FOR SELECT TO authenticated
  USING (public.user_role() = 'rep');

CREATE POLICY service_all_ledger ON minute_ledger
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================
-- Policies: payments
-- ============================================

CREATE POLICY admin_all_payments ON payments
  FOR ALL TO authenticated
  USING (public.user_role() = 'admin')
  WITH CHECK (public.user_role() = 'admin');

CREATE POLICY rep_read_payments ON payments
  FOR SELECT TO authenticated
  USING (public.user_role() = 'rep');

CREATE POLICY service_all_payments ON payments
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================
-- Policies: payment_packages
-- ============================================

CREATE POLICY admin_all_packages ON payment_packages
  FOR ALL TO authenticated
  USING (public.user_role() = 'admin')
  WITH CHECK (public.user_role() = 'admin');

CREATE POLICY rep_read_packages ON payment_packages
  FOR SELECT TO authenticated
  USING (public.user_role() = 'rep');

CREATE POLICY service_all_packages ON payment_packages
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================
-- Policies: task_categories
-- ============================================

CREATE POLICY admin_all_categories ON task_categories
  FOR ALL TO authenticated
  USING (public.user_role() = 'admin')
  WITH CHECK (public.user_role() = 'admin');

CREATE POLICY rep_read_categories ON task_categories
  FOR SELECT TO authenticated
  USING (true); -- all authenticated users can read

CREATE POLICY service_all_categories ON task_categories
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================
-- Policies: task_benchmarks
-- ============================================

CREATE POLICY admin_all_benchmarks ON task_benchmarks
  FOR ALL TO authenticated
  USING (public.user_role() = 'admin')
  WITH CHECK (public.user_role() = 'admin');

CREATE POLICY rep_read_benchmarks ON task_benchmarks
  FOR SELECT TO authenticated
  USING (public.user_role() = 'rep');

CREATE POLICY service_all_benchmarks ON task_benchmarks
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================
-- Policies: customer_credentials
-- NO direct access for reps — must use vault API with service_role
-- ============================================

CREATE POLICY admin_all_credentials ON customer_credentials
  FOR ALL TO authenticated
  USING (public.user_role() = 'admin')
  WITH CHECK (public.user_role() = 'admin');

CREATE POLICY service_all_credentials ON customer_credentials
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================
-- Policies: credential_access_log
-- ============================================

CREATE POLICY admin_read_access_log ON credential_access_log
  FOR SELECT TO authenticated
  USING (public.user_role() = 'admin');

CREATE POLICY service_all_access_log ON credential_access_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================
-- Policies: callback_requests
-- ============================================

CREATE POLICY admin_all_callbacks ON callback_requests
  FOR ALL TO authenticated
  USING (public.user_role() = 'admin')
  WITH CHECK (public.user_role() = 'admin');

CREATE POLICY rep_read_callbacks ON callback_requests
  FOR SELECT TO authenticated
  USING (public.user_role() = 'rep');

CREATE POLICY rep_update_callbacks ON callback_requests
  FOR UPDATE TO authenticated
  USING (public.user_role() = 'rep')
  WITH CHECK (public.user_role() = 'rep');

CREATE POLICY service_all_callbacks ON callback_requests
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================
-- Policies: admin_settings
-- ============================================

CREATE POLICY admin_all_settings ON admin_settings
  FOR ALL TO authenticated
  USING (public.user_role() = 'admin')
  WITH CHECK (public.user_role() = 'admin');

-- Reps: read settings (need for call flow config)
CREATE POLICY rep_read_settings ON admin_settings
  FOR SELECT TO authenticated
  USING (public.user_role() = 'rep');

CREATE POLICY service_all_settings ON admin_settings
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================
-- Policies: disclosure_prompts
-- ============================================

CREATE POLICY admin_all_disclosures ON disclosure_prompts
  FOR ALL TO authenticated
  USING (public.user_role() = 'admin')
  WITH CHECK (public.user_role() = 'admin');

CREATE POLICY rep_read_disclosures ON disclosure_prompts
  FOR SELECT TO authenticated
  USING (public.user_role() = 'rep');

CREATE POLICY service_all_disclosures ON disclosure_prompts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================
-- Policies: admin_audit_log
-- ============================================

CREATE POLICY admin_all_audit_log ON admin_audit_log
  FOR ALL TO authenticated
  USING (public.user_role() = 'admin')
  WITH CHECK (public.user_role() = 'admin');

CREATE POLICY service_all_audit_log ON admin_audit_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================
-- SEED DATA
-- ============================================

-- Task categories
INSERT INTO task_categories (name, sort_order) VALUES
  ('Online Shopping', 1),
  ('Application Filling', 2),
  ('Account Help', 3),
  ('Scheduling', 4),
  ('Bill Payment Assistance', 5),
  ('Government Forms', 6),
  ('General Online Help', 7),
  ('Other', 8);

-- Task benchmarks (linked to categories)
INSERT INTO task_benchmarks (task_category_id, expected_min_minutes, expected_max_minutes, flag_threshold_minutes)
SELECT id, 10, 20, 30 FROM task_categories WHERE name = 'Online Shopping'
UNION ALL
SELECT id, 15, 30, 45 FROM task_categories WHERE name = 'Application Filling'
UNION ALL
SELECT id, 10, 25, 35 FROM task_categories WHERE name = 'Account Help'
UNION ALL
SELECT id, 5, 15, 25 FROM task_categories WHERE name = 'Scheduling'
UNION ALL
SELECT id, 5, 15, 25 FROM task_categories WHERE name = 'Bill Payment Assistance'
UNION ALL
SELECT id, 15, 30, 45 FROM task_categories WHERE name = 'Government Forms'
UNION ALL
SELECT id, 10, 25, 35 FROM task_categories WHERE name = 'General Online Help'
UNION ALL
SELECT id, 5, 30, 45 FROM task_categories WHERE name = 'Other';

-- Payment packages
INSERT INTO payment_packages (name, minutes, price, sort_order) VALUES
  ('Basic', 30, 29.99, 1),
  ('Standard', 60, 49.99, 2),
  ('Premium', 120, 89.99, 3);

-- Admin settings
INSERT INTO admin_settings (key, value, description) VALUES
  ('negative_balance_enabled', 'true', 'Allow customers to go into negative minute balance'),
  ('max_negative_balance', '-10', 'Maximum negative balance in minutes'),
  ('first_time_zero_balance', '"allow"', 'Behavior for first-time callers with zero balance: allow, warn, or block'),
  ('rep_continue_after_zero', 'true', 'Whether reps can continue a call after balance reaches zero'),
  ('ai_analysis_enabled', 'true', 'Enable AI analysis for every call'),
  ('minute_announcement_enabled', 'true', 'Announce remaining minutes to caller'),
  ('minute_announcement_text', '"You currently have {minutes} minutes remaining."', 'Text template for minute announcement'),
  ('max_call_duration_minutes', '20', 'Maximum call duration before auto-disconnect warning'),
  ('extension_minutes', '5', 'Minutes added per call extension'),
  ('max_extensions_per_call', '2', 'Maximum number of extensions a rep can use per call'),
  ('queue_max_wait_minutes', '15', 'Maximum wait time in queue before offering callback'),
  ('queue_callback_threshold', '3', 'Number of callers in queue before offering callback option'),
  ('hold_music_url', '""', 'URL to custom hold music file'),
  ('queue_position_announcement', 'true', 'Announce caller position in queue');

-- Disclosure prompts
INSERT INTO disclosure_prompts (name, prompt_text, is_enabled, plays_before_routing, sort_order) VALUES
  ('Recording Disclosure', 'This call may be recorded for quality assurance and training purposes.', true, true, 1),
  ('Terms Agreement', 'By continuing, you agree to our terms of service and privacy policy.', false, true, 2);

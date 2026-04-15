-- Combined migrations for Assistance Platform
-- Generated: 2026-04-14T22:29:45.337Z

-- ========== 001_create_customers.sql ==========
-- ============================================
-- 001: Customers table
-- ============================================

CREATE TYPE customer_status AS ENUM ('active', 'inactive', 'flagged');

CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL,
  primary_phone TEXT NOT NULL,
  secondary_phone TEXT,
  email TEXT,
  address TEXT,
  internal_notes TEXT,
  status customer_status NOT NULL DEFAULT 'active',
  current_balance_minutes NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_minutes_purchased NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_minutes_used NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_customers_primary_phone ON customers (primary_phone);
CREATE INDEX idx_customers_secondary_phone ON customers (secondary_phone) WHERE secondary_phone IS NOT NULL;
CREATE INDEX idx_customers_email ON customers (email) WHERE email IS NOT NULL;
CREATE INDEX idx_customers_full_name ON customers USING gin (to_tsvector('english', full_name));

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_customers_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ========== 002_create_reps.sql ==========
-- ============================================
-- 002: Reps table
-- ============================================

CREATE TYPE rep_status AS ENUM ('available', 'busy', 'offline', 'on_call');

CREATE TABLE reps (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone_extension TEXT,
  status rep_status NOT NULL DEFAULT 'offline',
  signalwire_resource_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_reps_updated_at
  BEFORE UPDATE ON reps
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ========== 003_create_task_categories.sql ==========
-- ============================================
-- 003: Task categories
-- ============================================

CREATE TABLE task_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ========== 004_create_calls.sql ==========
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


-- ========== 005_create_call_analyses.sql ==========
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


-- ========== 006_create_minute_ledger.sql ==========
-- ============================================
-- 006: Minute ledger
-- ============================================

CREATE TYPE ledger_entry_type AS ENUM ('purchase', 'deduction', 'adjustment', 'refund');

CREATE TABLE minute_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  entry_type ledger_entry_type NOT NULL,
  minutes_amount NUMERIC(10,2) NOT NULL, -- positive for add, negative for deduct
  dollar_amount NUMERIC(10,2),
  reason TEXT,
  performed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL, -- null = system
  call_id UUID REFERENCES calls(id) ON DELETE SET NULL,
  payment_id UUID, -- FK added after payments table exists
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_minute_ledger_customer_id ON minute_ledger (customer_id);
CREATE INDEX idx_minute_ledger_created_at ON minute_ledger (created_at DESC);


-- ========== 007_create_payment_packages.sql ==========
-- ============================================
-- 007: Payment packages
-- ============================================

CREATE TABLE payment_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  minutes INT NOT NULL,
  price NUMERIC(10,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_payment_packages_updated_at
  BEFORE UPDATE ON payment_packages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ========== 008_create_payments.sql ==========
-- ============================================
-- 008: Payments
-- ============================================

CREATE TYPE payment_status AS ENUM ('pending', 'completed', 'failed', 'refunded');

CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  package_id UUID REFERENCES payment_packages(id) ON DELETE SET NULL,
  package_name TEXT,
  minutes_added NUMERIC(10,2) NOT NULL,
  amount_paid NUMERIC(10,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  payment_status payment_status NOT NULL DEFAULT 'pending',
  sola_transaction_ref TEXT,
  sola_token TEXT, -- xToken for card-on-file
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_payments_customer_id ON payments (customer_id);
CREATE INDEX idx_payments_created_at ON payments (created_at DESC);

-- Now add FK from minute_ledger to payments
ALTER TABLE minute_ledger
  ADD CONSTRAINT fk_minute_ledger_payment
  FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE SET NULL;


-- ========== 009_create_task_benchmarks.sql ==========
-- ============================================
-- 009: Task benchmarks
-- ============================================

CREATE TABLE task_benchmarks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_category_id UUID NOT NULL UNIQUE REFERENCES task_categories(id) ON DELETE CASCADE,
  expected_min_minutes INT NOT NULL,
  expected_max_minutes INT NOT NULL,
  flag_threshold_minutes INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_task_benchmarks_updated_at
  BEFORE UPDATE ON task_benchmarks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ========== 010_create_customer_credentials.sql ==========
-- ============================================
-- 010: Customer credentials (password vault)
-- ============================================

CREATE TABLE customer_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  service_name TEXT NOT NULL,       -- e.g. "Amazon", "Bank of America"
  username TEXT,                     -- login username/email (stored plain)
  encrypted_password BYTEA NOT NULL, -- AES-256-GCM encrypted
  encrypted_notes BYTEA,             -- optional encrypted notes
  encryption_key_id UUID,            -- reference to Supabase Vault key
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_accessed_at TIMESTAMPTZ,
  last_accessed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX idx_customer_credentials_customer_id ON customer_credentials (customer_id);

CREATE TRIGGER trg_customer_credentials_updated_at
  BEFORE UPDATE ON customer_credentials
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ========== 011_create_credential_access_log.sql ==========
-- ============================================
-- 011: Credential access log (audit trail)
-- ============================================

CREATE TYPE credential_action AS ENUM ('view', 'copy');

CREATE TABLE credential_access_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id UUID NOT NULL REFERENCES customer_credentials(id) ON DELETE CASCADE,
  rep_id UUID NOT NULL REFERENCES reps(id) ON DELETE CASCADE,
  call_id UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  action credential_action NOT NULL,
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_credential_access_log_credential ON credential_access_log (credential_id);
CREATE INDEX idx_credential_access_log_rep ON credential_access_log (rep_id);


-- ========== 012_create_callback_requests.sql ==========
-- ============================================
-- 012: Callback requests
-- ============================================

CREATE TYPE callback_status AS ENUM ('pending', 'called_back', 'expired');

CREATE TABLE callback_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number TEXT NOT NULL,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status callback_status NOT NULL DEFAULT 'pending',
  called_back_at TIMESTAMPTZ,
  called_back_by UUID REFERENCES reps(id) ON DELETE SET NULL,
  notes TEXT
);

CREATE INDEX idx_callback_requests_status ON callback_requests (status) WHERE status = 'pending';
CREATE INDEX idx_callback_requests_requested_at ON callback_requests (requested_at DESC);


-- ========== 013_create_admin_settings.sql ==========
-- ============================================
-- 013: Admin settings
-- ============================================

CREATE TABLE admin_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  value JSONB NOT NULL DEFAULT '{}',
  description TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);


-- ========== 014_create_disclosure_prompts.sql ==========
-- ============================================
-- 014: Disclosure prompts
-- ============================================

CREATE TABLE disclosure_prompts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  plays_before_routing BOOLEAN NOT NULL DEFAULT true,
  requires_acknowledgment BOOLEAN NOT NULL DEFAULT false,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_disclosure_prompts_updated_at
  BEFORE UPDATE ON disclosure_prompts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ========== 015_create_admin_audit_log.sql ==========
-- ============================================
-- 015: Admin audit log
-- ============================================

CREATE TABLE admin_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,     -- e.g. 'customer', 'call', 'setting'
  entity_id UUID,
  old_value JSONB,
  new_value JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_admin_audit_log_entity ON admin_audit_log (entity_type, entity_id);
CREATE INDEX idx_admin_audit_log_user ON admin_audit_log (user_id);
CREATE INDEX idx_admin_audit_log_created_at ON admin_audit_log (created_at DESC);


-- ========== 016_rls_policies_and_seeds.sql ==========
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



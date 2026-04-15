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

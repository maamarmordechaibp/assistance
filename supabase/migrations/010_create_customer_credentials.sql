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

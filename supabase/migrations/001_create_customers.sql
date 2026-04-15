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

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

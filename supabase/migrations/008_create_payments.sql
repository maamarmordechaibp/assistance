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

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

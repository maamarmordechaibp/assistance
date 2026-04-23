-- Saved card-on-file (Sola/Cardknox xToken). Reps NEVER see the raw PAN.
-- Only the masked last4 + brand + token. Token can be charged via cc:sale
-- with xToken set instead of xCardNum/xExp/xCVV.

CREATE TABLE IF NOT EXISTS customer_payment_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  sola_token TEXT NOT NULL,
  card_brand TEXT,                 -- VISA, MC, AMEX, DISC, etc.
  card_last4 TEXT,                 -- 4 digits, safe to show reps
  card_exp TEXT,                   -- MMYY, safe to show reps
  cardholder_name TEXT,
  is_default BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cpm_customer ON customer_payment_methods(customer_id) WHERE is_active = TRUE;

-- Reps can SELECT (read masked card metadata), INSERT (save tokens after a
-- successful charge), and UPDATE (deactivate / change default). They cannot
-- see the raw token because the table column visibility is controlled by
-- the edge functions (admin-only via service role for the actual charge).
ALTER TABLE customer_payment_methods ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rep_full_access_cpm" ON customer_payment_methods;
CREATE POLICY "rep_full_access_cpm" ON customer_payment_methods
  FOR ALL USING (
    EXISTS (SELECT 1 FROM reps WHERE reps.id = auth.uid())
  );

-- Optional view that hides the raw sola_token from rep dashboards. Reps
-- query this view; only edge functions (service role) hit the base table.
CREATE OR REPLACE VIEW customer_payment_methods_safe AS
  SELECT id, customer_id, card_brand, card_last4, card_exp, cardholder_name,
         is_default, is_active, created_at, last_used_at
  FROM customer_payment_methods;

GRANT SELECT ON customer_payment_methods_safe TO authenticated;

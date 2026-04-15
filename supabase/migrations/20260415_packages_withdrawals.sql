ALTER TABLE payment_packages ADD COLUMN IF NOT EXISTS description text;

CREATE TABLE IF NOT EXISTS owner_withdrawals (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  amount numeric(10,2) NOT NULL,
  method text NOT NULL DEFAULT 'bank_transfer',
  notes text,
  status text NOT NULL DEFAULT 'completed',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE owner_withdrawals ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'owner_withdrawals_admin' AND tablename = 'owner_withdrawals'
  ) THEN
    CREATE POLICY owner_withdrawals_admin ON owner_withdrawals FOR ALL USING (true) WITH CHECK (true);
  END IF;
END
$$;

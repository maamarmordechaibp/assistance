-- Phone aliases: lets a single customer be found by multiple phone numbers.
-- When a customer calls from a second/third number, an admin can add that
-- number here so future calls automatically link to the right customer record.

CREATE TABLE IF NOT EXISTS customer_phone_aliases (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  phone       TEXT NOT NULL,
  note        TEXT,             -- e.g. "work cell", "spouse's phone"
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_customer_phone_aliases_phone
  ON customer_phone_aliases (phone);

CREATE INDEX IF NOT EXISTS idx_customer_phone_aliases_customer
  ON customer_phone_aliases (customer_id);

ALTER TABLE customer_phone_aliases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_all" ON customer_phone_aliases FOR ALL
  USING  ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

CREATE POLICY "service_role" ON customer_phone_aliases FOR ALL
  USING  (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

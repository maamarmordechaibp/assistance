-- Product search bundles: rep generates a numbered list of options for a customer
-- (e.g. "12 hybrid bikes from Amazon under $400"). The PDF + per-option click-back
-- gives the rep a way to print-and-discuss without losing context.

CREATE TABLE IF NOT EXISTS customer_product_searches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  call_id UUID REFERENCES calls(id) ON DELETE SET NULL,
  rep_id UUID REFERENCES reps(id) ON DELETE SET NULL,
  query TEXT NOT NULL,
  source_url TEXT,
  site TEXT,                     -- 'amazon' | 'walmart' | 'bestbuy' | 'other'
  bb_session_id TEXT,
  options_count INT DEFAULT 0,
  pdf_storage_path TEXT,         -- supabase storage path once generated
  sent_email TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cps_customer ON customer_product_searches (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cps_call ON customer_product_searches (call_id);

CREATE TABLE IF NOT EXISTS customer_product_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id UUID NOT NULL REFERENCES customer_product_searches(id) ON DELETE CASCADE,
  option_number INT NOT NULL,    -- 1-based, matches PDF page number
  title TEXT,
  price TEXT,
  rating TEXT,
  image_url TEXT,
  product_url TEXT NOT NULL,
  raw_data JSONB
);

CREATE INDEX IF NOT EXISTS idx_cpo_search ON customer_product_options (search_id, option_number);

ALTER TABLE customer_product_searches ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_product_options  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rep_full_access_cps" ON customer_product_searches;
CREATE POLICY "rep_full_access_cps" ON customer_product_searches FOR ALL
  USING (EXISTS (SELECT 1 FROM reps WHERE reps.id = auth.uid()));

DROP POLICY IF EXISTS "rep_full_access_cpo" ON customer_product_options;
CREATE POLICY "rep_full_access_cpo" ON customer_product_options FOR ALL
  USING (EXISTS (SELECT 1 FROM reps WHERE reps.id = auth.uid()));

-- Service role can do everything (used by edge function + Next.js API routes)
DROP POLICY IF EXISTS "service_role_cps" ON customer_product_searches;
CREATE POLICY "service_role_cps" ON customer_product_searches FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "service_role_cpo" ON customer_product_options;
CREATE POLICY "service_role_cpo" ON customer_product_options FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

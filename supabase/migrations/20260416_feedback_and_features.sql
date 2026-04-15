-- Add preferred_rep_id to customers
ALTER TABLE customers ADD COLUMN IF NOT EXISTS preferred_rep_id UUID REFERENCES reps(id);

-- Create customer_feedback table
CREATE TABLE IF NOT EXISTS customer_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id),
  rep_id UUID NOT NULL REFERENCES reps(id),
  call_id UUID REFERENCES calls(id),
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE customer_feedback ENABLE ROW LEVEL SECURITY;

-- RLS policies for customer_feedback
DO $$ BEGIN
  CREATE POLICY feedback_admin_all ON customer_feedback
    FOR ALL TO authenticated
    USING ((SELECT (auth.jwt()->'app_metadata'->>'role') = 'admin'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY feedback_rep_read ON customer_feedback
    FOR SELECT TO authenticated
    USING ((SELECT (auth.jwt()->'app_metadata'->>'role') = 'rep'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Add terms_and_conditions admin setting
INSERT INTO admin_settings (key, value, description)
VALUES (
  'terms_and_conditions',
  '"By using this service you agree to be recorded for quality assurance. All calls are confidential. Service rates are based on your purchased package. Refunds are handled on a case-by-case basis. For full terms visit our website."',
  'Terms and conditions read to callers via IVR'
) ON CONFLICT (key) DO NOTHING;

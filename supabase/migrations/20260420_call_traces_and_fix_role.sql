-- Call traces for debugging call flow
CREATE TABLE IF NOT EXISTS call_traces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_sid TEXT,
  step TEXT,
  from_number TEXT,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- No RLS needed - service role only writes, reps/admins read via edge function
ALTER TABLE call_traces ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_all_call_traces ON call_traces
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY authenticated_read_call_traces ON call_traces
  FOR SELECT TO authenticated USING (true);

-- Fix user_role() to read app_metadata.role first
-- The old version returned 'authenticated' (the PostgREST role) before checking app_metadata
CREATE OR REPLACE FUNCTION public.user_role()
RETURNS TEXT AS $$
  SELECT coalesce(
    (current_setting('request.jwt.claims', true)::json->'app_metadata'->>'role'),
    NULLIF(current_setting('request.jwt.claims', true)::json->>'role', 'authenticated')
  );
$$ LANGUAGE sql STABLE;

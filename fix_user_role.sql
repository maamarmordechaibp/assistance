CREATE OR REPLACE FUNCTION public.user_role()
RETURNS TEXT AS $$
  SELECT coalesce(
    (current_setting('request.jwt.claims', true)::json->'app_metadata'->>'role'),
    NULLIF(current_setting('request.jwt.claims', true)::json->>'role', 'authenticated')
  );
$$ LANGUAGE sql STABLE;

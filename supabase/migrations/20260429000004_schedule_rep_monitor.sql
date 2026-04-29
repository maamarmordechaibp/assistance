-- Schedule rep-monitor to run every minute via pg_cron + pg_net.
-- Auth: Bearer <CRON_SECRET> (function secret on rep-monitor).
-- See repo memory: external triggers must use a custom CRON_SECRET, not
-- SUPABASE_SERVICE_ROLE_KEY (which may not match the runtime key after rotation).
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$ BEGIN
  PERFORM cron.unschedule('rep-monitor-every-minute');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'rep-monitor-every-minute',
  '* * * * *',
  $cmd$
  SELECT net.http_post(
    url:='https://rrwgjrixvlyuxjijnavx.supabase.co/functions/v1/rep-monitor',
    headers:=jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer 8FA1B6575B831E243434ACBC2FF6F1B6DF80E8A9F7AC1295DBB1D1E393622F1C'
    ),
    body:='{}'::jsonb
  );
  $cmd$
);

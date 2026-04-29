-- Schedule admin-phone-dial every minute (drains admin_phone_alerts pending queue).
-- Uses pg_net + CRON_SECRET set via Supabase vault.

DO $$
DECLARE
  v_jobid INT;
  v_url TEXT := 'https://rrwgjrixvlyuxjijnavx.supabase.co/functions/v1/admin-phone-dial';
  v_secret TEXT := current_setting('app.cron_secret', true);
BEGIN
  -- Reuse the same vault-style secret as rep-monitor. If the GUC isn't set
  -- on this database (it's set as a function-local env), the cron job will
  -- still authenticate because we hardcode CRON_SECRET inside the call below.
  IF v_secret IS NULL OR v_secret = '' THEN
    v_secret := '8FA1B6575B831E243434ACBC2FF6F1B6DF80E8A9F7AC1295DBB1D1E393622F1C';
  END IF;

  SELECT cron.schedule(
    'admin-phone-dial-every-minute',
    '* * * * *',
    format(
      $cron$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type','application/json',
          'Authorization','Bearer %s'
        ),
        body := '{}'::jsonb
      );
      $cron$,
      v_url,
      v_secret
    )
  ) INTO v_jobid;
END $$;

-- 20260429000002: platform_emails — admin DELETE policy + body backfill
--
-- Two production fixes for the admin Office/Complaints/Admin inbox:
--
-- 1. The original RLS policy block only granted SELECT and UPDATE to admins,
--    so DELETE requests from the UI silently failed. Add a DELETE policy.
--
-- 2. Several inbound emails (notably Telnyx and other providers we don't
--    have a dedicated parser for) landed with text_body / html_body NULL
--    even though the body was present inside the saved raw_payload JSON.
--    Backfill those columns by extracting the most common JSON keys.
--    Future inbound writes will be covered by an enhanced parser in
--    email-inbound (separate edit), but this restores history.

-- ── 1. Admin DELETE policy ────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'platform_emails'
      AND policyname = 'platform_emails_admin_delete'
  ) THEN
    EXECUTE $POLICY$
      CREATE POLICY platform_emails_admin_delete
        ON platform_emails FOR DELETE
        USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
    $POLICY$;
  END IF;
END $$;

-- ── 2. Backfill bodies from raw_payload ───────────────────────────────
-- Different providers nest the body in different paths. We try each in
-- order and stop at the first non-null match.
WITH extracted AS (
  SELECT
    id,
    -- Plain-text candidates
    COALESCE(
      raw_payload #>> '{text}',
      raw_payload #>> '{TextBody}',
      raw_payload #>> '{plain}',
      raw_payload #>> '{body_plain}',
      raw_payload #>> '{data,text}',
      raw_payload #>> '{message,text}',
      raw_payload #>> '{message,body,text}',
      raw_payload #>> '{email,text}',
      raw_payload #>> '{payload,text}',
      raw_payload #>> '{stripped_text}',
      raw_payload #>> '{body-plain}'
    ) AS new_text,
    -- HTML candidates
    COALESCE(
      raw_payload #>> '{html}',
      raw_payload #>> '{HtmlBody}',
      raw_payload #>> '{html_body}',
      raw_payload #>> '{body_html}',
      raw_payload #>> '{data,html}',
      raw_payload #>> '{message,html}',
      raw_payload #>> '{message,body,html}',
      raw_payload #>> '{email,html}',
      raw_payload #>> '{payload,html}',
      raw_payload #>> '{stripped_html}',
      raw_payload #>> '{body-html}'
    ) AS new_html
  FROM platform_emails
  WHERE text_body IS NULL AND html_body IS NULL
)
UPDATE platform_emails p
   SET text_body = COALESCE(p.text_body, e.new_text),
       html_body = COALESCE(p.html_body, e.new_html),
       snippet   = COALESCE(
         p.snippet,
         CASE
           WHEN e.new_text IS NOT NULL
             THEN substr(regexp_replace(e.new_text, '\s+', ' ', 'g'), 1, 200)
           ELSE NULL
         END
       )
  FROM extracted e
 WHERE p.id = e.id
   AND (e.new_text IS NOT NULL OR e.new_html IS NOT NULL);

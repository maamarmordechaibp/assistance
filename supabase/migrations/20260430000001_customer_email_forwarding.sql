-- Customer email forwarding + soft delete
--
-- Adds:
--   • customers.auto_forward_mode    - 'off' | 'all' | 'allowlist'
--   • customers.auto_forward_senders - TEXT[] of email addresses or domains
--                                      (matched case-insensitively, suffix-match
--                                      so 'amazon.com' matches 'noreply@amazon.com')
--   • customer_emails.deleted_at     - soft-delete timestamp (rep "Delete" sets this)
--   • customer_emails.deleted_by     - rep/admin user id who deleted it
--   • customer_emails.forwarded_at   - timestamp of last forward to personal_email
--   • customer_emails.forwarded_to   - personal_email address it was forwarded to
--
-- Soft delete is enforced application-side: queries filter `deleted_at IS NULL`.
-- Hard delete remains gated by the existing DELETE RLS policy (admin only).

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS auto_forward_mode TEXT
    NOT NULL DEFAULT 'off'
    CHECK (auto_forward_mode IN ('off','all','allowlist')),
  ADD COLUMN IF NOT EXISTS auto_forward_senders TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN customers.auto_forward_mode IS
  'Auto-forward behaviour for inbound customer_emails. off|all|allowlist.';
COMMENT ON COLUMN customers.auto_forward_senders IS
  'When auto_forward_mode=allowlist, only forward emails whose from_address ' ||
  'ends with one of these entries (e.g. ''amazon.com'' or ''noreply@walmart.com'').';

ALTER TABLE customer_emails
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID,
  ADD COLUMN IF NOT EXISTS forwarded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS forwarded_to TEXT;

CREATE INDEX IF NOT EXISTS customer_emails_not_deleted_idx
  ON customer_emails (received_at DESC)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN customer_emails.deleted_at IS
  'Soft-delete timestamp. Rows with non-null deleted_at are hidden from the rep UI.';
COMMENT ON COLUMN customer_emails.forwarded_at IS
  'Timestamp the email was last forwarded to the customer''s personal_email.';

-- Admin DELETE policy — needed for the "Permanently delete" admin action.
-- Reps cannot DELETE; they can only UPDATE deleted_at via the existing
-- customer_emails_update_authenticated policy.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'customer_emails'
      AND policyname = 'customer_emails_admin_delete'
  ) THEN
    EXECUTE $POLICY$
      CREATE POLICY customer_emails_admin_delete
        ON customer_emails FOR DELETE
        USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
    $POLICY$;
  END IF;
END $$;

-- ============================================================
-- Platform-level email inboxes
-- ============================================================
-- Stores emails sent directly to shared office / admin addresses:
--   office@offlinesbrowse.com      — general enquiries
--   complaints@offlinesbrowse.com  — complaints & disputes
--   admin@offlinesbrowse.com       — internal/admin correspondence
--
-- These inboxes are ADMIN-ONLY. Representatives cannot read them.
-- The email_direction type is already created by the customer_emails migration.

CREATE TABLE platform_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which platform mailbox received this message.
  mailbox TEXT NOT NULL,
  direction email_direction NOT NULL DEFAULT 'inbound',

  -- Envelope
  from_address TEXT,
  from_name TEXT,
  to_addresses TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  cc_addresses TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  reply_to TEXT,
  subject TEXT,

  -- Content
  text_body TEXT,
  html_body TEXT,
  snippet TEXT,                 -- first ~200 chars of text, for list views

  -- Metadata
  message_id TEXT,
  in_reply_to TEXT,
  provider TEXT,
  provider_event_id TEXT,
  raw_payload JSONB,

  -- Lifecycle
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  starred BOOLEAN NOT NULL DEFAULT FALSE,
  received_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_platform_emails_mailbox_received
  ON platform_emails (mailbox, received_at DESC);
CREATE INDEX idx_platform_emails_received
  ON platform_emails (received_at DESC);
CREATE UNIQUE INDEX uniq_platform_emails_provider_event
  ON platform_emails (provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL;

CREATE TRIGGER trg_platform_emails_updated_at
  BEFORE UPDATE ON platform_emails
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS: admin-only access.
ALTER TABLE platform_emails ENABLE ROW LEVEL SECURITY;

CREATE POLICY platform_emails_admin_select
  ON platform_emails FOR SELECT TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

CREATE POLICY platform_emails_admin_update
  ON platform_emails FOR UPDATE TO authenticated
  USING  ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

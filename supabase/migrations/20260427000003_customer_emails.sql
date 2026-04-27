-- ============================================
-- Customer email storage + outbound send log
-- ============================================
-- Captures every inbound email delivered to <assigned_email> and every email
-- the rep sends FROM <assigned_email> on behalf of the customer. This is what
-- lets reps see Amazon order confirmations, OTP codes, password-reset emails,
-- and shipping notifications attributed to the right customer in real-time.

CREATE TYPE email_direction AS ENUM ('inbound', 'outbound');

CREATE TABLE customer_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  -- Local mailbox the message was received at (or sent from) — kept even if
  -- customer_id is NULL so we can reconcile orphans later.
  mailbox TEXT NOT NULL,
  direction email_direction NOT NULL,

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
  -- Detected one-time-passcode (string of 4-10 digits/letters) extracted from
  -- the subject or body so the rep panel can surface it instantly.
  detected_otp TEXT,

  -- Metadata
  message_id TEXT,              -- RFC822 Message-ID
  in_reply_to TEXT,
  provider TEXT,                -- 'resend' | 'cloudflare' | 'postmark' | ...
  provider_event_id TEXT,       -- idempotency key from the inbound webhook
  raw_payload JSONB,            -- full provider payload for debugging

  -- Lifecycle
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  starred BOOLEAN NOT NULL DEFAULT FALSE,
  received_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_customer_emails_customer_received
  ON customer_emails (customer_id, received_at DESC);
CREATE INDEX idx_customer_emails_mailbox_received
  ON customer_emails (mailbox, received_at DESC);
CREATE INDEX idx_customer_emails_direction_received
  ON customer_emails (direction, received_at DESC);
-- Idempotency: a single provider event should never be inserted twice.
CREATE UNIQUE INDEX uniq_customer_emails_provider_event
  ON customer_emails (provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL;
-- Quick OTP lookups for the rep UI.
CREATE INDEX idx_customer_emails_otp
  ON customer_emails (customer_id, received_at DESC)
  WHERE detected_otp IS NOT NULL;

CREATE TRIGGER trg_customer_emails_updated_at
  BEFORE UPDATE ON customer_emails
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Attachments (stored as references — actual bytes live in Supabase Storage
-- bucket `customer_email_attachments` populated by the email-inbound function).
CREATE TABLE customer_email_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id UUID NOT NULL REFERENCES customer_emails(id) ON DELETE CASCADE,
  filename TEXT,
  content_type TEXT,
  byte_size BIGINT,
  storage_path TEXT,            -- 'customer_email_attachments/<uuid>/<file>'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_customer_email_attachments_email
  ON customer_email_attachments (email_id);

-- RLS: rep app uses service-role key, so we don't need fine-grained policies
-- here. Lock the table down to authenticated reps via service-role only.
ALTER TABLE customer_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_email_attachments ENABLE ROW LEVEL SECURITY;
-- Authenticated users (reps logged into the admin app) can read all email rows.
CREATE POLICY customer_emails_read_authenticated
  ON customer_emails FOR SELECT TO authenticated USING (true);
CREATE POLICY customer_email_attachments_read_authenticated
  ON customer_email_attachments FOR SELECT TO authenticated USING (true);
-- Reps may toggle read / starred state.
CREATE POLICY customer_emails_update_authenticated
  ON customer_emails FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- ============================================
-- SMS Inbox: store inbound SMS messages on the company SignalWire number,
-- detect OTPs, and (when possible) auto-attach them to:
--   • the customer whose primary_phone matches the sender, AND
--   • the rep currently on an active call with that customer.
--
-- Used for one-time-passcode forwarding so reps can complete account
-- verifications without asking the customer to read codes aloud.
-- ============================================

CREATE TABLE IF NOT EXISTS sms_inbound (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_sid         TEXT UNIQUE,                  -- SignalWire MessageSid (idempotency)
  to_number           TEXT NOT NULL,                -- the company number that received the SMS
  from_number         TEXT NOT NULL,                -- normalized E.164 sender
  body                TEXT,
  num_segments        INT,
  num_media           INT DEFAULT 0,

  detected_otp        TEXT,                          -- extracted code, if found
  customer_id         UUID REFERENCES customers(id) ON DELETE SET NULL,
  call_id             UUID REFERENCES calls(id)     ON DELETE SET NULL,
  rep_id              UUID REFERENCES reps(id)      ON DELETE SET NULL,

  is_read             BOOLEAN NOT NULL DEFAULT false,
  read_at             TIMESTAMPTZ,
  read_by_rep_id      UUID REFERENCES reps(id) ON DELETE SET NULL,

  received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload         JSONB,                         -- original webhook form for debugging

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sms_inbound_received_at  ON sms_inbound (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_inbound_customer_id  ON sms_inbound (customer_id);
CREATE INDEX IF NOT EXISTS idx_sms_inbound_call_id      ON sms_inbound (call_id);
CREATE INDEX IF NOT EXISTS idx_sms_inbound_rep_id       ON sms_inbound (rep_id);
CREATE INDEX IF NOT EXISTS idx_sms_inbound_from_number  ON sms_inbound (from_number);
CREATE INDEX IF NOT EXISTS idx_sms_inbound_otp          ON sms_inbound (detected_otp) WHERE detected_otp IS NOT NULL;

ALTER TABLE sms_inbound ENABLE ROW LEVEL SECURITY;

-- Admins see everything.
DROP POLICY IF EXISTS sms_inbound_admin_all ON sms_inbound;
CREATE POLICY sms_inbound_admin_all ON sms_inbound
  FOR ALL TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- Reps see only SMS that have been auto-attached to them (i.e. the customer
-- they were on a call with at the time the SMS arrived).
DROP POLICY IF EXISTS sms_inbound_rep_read ON sms_inbound;
CREATE POLICY sms_inbound_rep_read ON sms_inbound
  FOR SELECT TO authenticated
  USING (
    rep_id IN (
      SELECT id FROM reps WHERE lower(email) = lower(auth.jwt() ->> 'email')
    )
  );

-- Reps may mark their own SMS as read.
DROP POLICY IF EXISTS sms_inbound_rep_update ON sms_inbound;
CREATE POLICY sms_inbound_rep_update ON sms_inbound
  FOR UPDATE TO authenticated
  USING (
    rep_id IN (SELECT id FROM reps WHERE lower(email) = lower(auth.jwt() ->> 'email'))
  )
  WITH CHECK (
    rep_id IN (SELECT id FROM reps WHERE lower(email) = lower(auth.jwt() ->> 'email'))
  );

-- Realtime: emit changes so the inbox UI can subscribe.
ALTER PUBLICATION supabase_realtime ADD TABLE sms_inbound;

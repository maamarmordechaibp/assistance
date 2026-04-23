-- ============================================
-- 20260423: Add dial targets for reps
-- ============================================
-- phone_e164 — E.164 PSTN number to ring the rep (cell, landline, desk).
-- sip_uri    — optional SIP URI (e.g. sip:user@accuinfo.signalwire.com) used
--              to reach a rep via a SIP softphone/deskphone. Takes priority
--              over phone_e164 when both are set (free SIP-to-SIP audio).
ALTER TABLE reps
  ADD COLUMN IF NOT EXISTS phone_e164 TEXT,
  ADD COLUMN IF NOT EXISTS sip_uri    TEXT;

-- Simple sanity check: E.164 starts with + and 7–15 digits.
ALTER TABLE reps
  DROP CONSTRAINT IF EXISTS reps_phone_e164_format;
ALTER TABLE reps
  ADD  CONSTRAINT reps_phone_e164_format
  CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{6,14}$');

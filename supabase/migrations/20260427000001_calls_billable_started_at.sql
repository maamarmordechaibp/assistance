-- ============================================
-- 20260427000001: Billing-start gate
-- ============================================
--
-- Reps need to verbally confirm with the customer that they still need help
-- BEFORE the minute meter starts running. Without this column, minutes are
-- deducted from the customer's balance based on `connected_at` (the moment
-- the audio bridge succeeds) — so a customer who picks up just to say
-- "no, I'm done, thanks" is still billed for the call. With this column,
-- billing only counts time from when the rep clicks "Confirm & Continue".
-- ============================================

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS billable_started_at TIMESTAMPTZ;

COMMENT ON COLUMN calls.billable_started_at IS
  'When the rep confirmed with the customer that they still need help. Billing duration is computed from this point, notcted_at.';

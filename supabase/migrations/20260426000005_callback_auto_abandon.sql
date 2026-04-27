-- ============================================
-- 20260426000005: Auto-callbacks for abandoned calls
-- ============================================
--
-- The edge functions write `caller_name`, `call_sid`, `rep_id`, and
-- `is_general` into `callback_requests`, but those columns were never
-- added to the table. Inserts that included them were silently failing
-- (`.catch(() => {})`), and the abandoned-caller path never wrote a row
-- at all — a missed call simply disappeared. This migration:
--
--   1. Adds the missing columns.
--   2. Adds a partial UNIQUE index on `call_sid` so the abandoned-call
--      auto-insert is idempotent (same SID can't create two rows).
--   3. Back-fills callback rows for historical calls that never reached
--      a rep (no `rep_id` / `connected_at`) so the rep team can see and
--      return them.
-- ============================================

-- 1. Missing columns referenced by sw-inbound, sw-callback-choice and the
--    callbacks edge function.
ALTER TABLE callback_requests
  ADD COLUMN IF NOT EXISTS caller_name TEXT,
  ADD COLUMN IF NOT EXISTS call_sid    TEXT,
  ADD COLUMN IF NOT EXISTS rep_id      UUID REFERENCES reps(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_general  BOOLEAN NOT NULL DEFAULT TRUE;

-- 2. Idempotency for auto-insert from queue-exit / dial-fallback. The
--    sw-inbound function uses ON CONFLICT (call_sid) DO NOTHING so a
--    second exit event for the same SignalWire CallSid is harmless.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_callback_requests_call_sid
  ON callback_requests (call_sid)
  WHERE call_sid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_callback_requests_rep_id
  ON callback_requests (rep_id)
  WHERE rep_id IS NOT NULL;

-- 3. Back-fill: every past call that never reached a rep and isn't
--    already represented in callback_requests becomes a pending callback.
--    Skip rows where we don't have a phone number to call back.
INSERT INTO callback_requests
  (phone_number, customer_id, caller_name, call_sid, is_general, requested_at, status)
SELECT
  COALESCE(c.inbound_phone, cu.primary_phone) AS phone_number,
  c.customer_id,
  cu.full_name                                AS caller_name,
  c.call_sid,
  TRUE                                        AS is_general,
  c.started_at                                AS requested_at,
  'pending'::callback_status                  AS status
FROM calls c
LEFT JOIN customers cu ON cu.id = c.customer_id
WHERE c.rep_id IS NULL
  AND c.connected_at IS NULL
  AND c.call_sid IS NOT NULL
  AND COALESCE(c.inbound_phone, cu.primary_phone) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM callback_requests cb
     WHERE cb.call_sid = c.call_sid
  )
ON CONFLICT (call_sid) WHERE call_sid IS NOT NULL DO NOTHING;

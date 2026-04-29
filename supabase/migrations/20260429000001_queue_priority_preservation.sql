-- 20260429000001: Preserve queue position across a callback round-trip.
--
-- When a caller is, say, #2 in queue and chooses callback rather than holding,
-- they should not lose their place if the rep can't get to them before they
-- call back themselves (or before our callback dial reaches them and they
-- end up re-entering the queue). We solve this with a sort key that's
-- separate from enqueued_at:
--
--   call_queue.priority_at  — what the rep softphone sorts by. Defaults
--                             to enqueued_at, but can be set to an EARLIER
--                             timestamp when re-enqueuing a callback caller
--                             so they jump ahead of newer arrivals.
--
--   callback_requests.original_enqueued_at — captured at the moment the
--                             caller pressed 1-for-callback so we can
--                             restore that priority on their next call.
--
-- All ordering remains stable (priority_at, then id) and existing rows
-- continue to behave exactly as before because the default copies enqueued_at.

ALTER TABLE call_queue
  ADD COLUMN IF NOT EXISTS priority_at TIMESTAMPTZ;

-- Backfill existing rows so the new sort key matches the old one.
UPDATE call_queue SET priority_at = enqueued_at WHERE priority_at IS NULL;

ALTER TABLE call_queue
  ALTER COLUMN priority_at SET NOT NULL,
  ALTER COLUMN priority_at SET DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_call_queue_waiting_priority
  ON call_queue (priority_at) WHERE status = 'waiting';

ALTER TABLE callback_requests
  ADD COLUMN IF NOT EXISTS original_enqueued_at TIMESTAMPTZ;

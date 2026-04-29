-- ============================================
-- 20260429000007: Smart routing — preferred_rep_id on call_queue
-- ============================================
-- Adds a non-exclusive routing hint. Unlike target_rep_id (which gates RLS),
-- preferred_rep_id is purely advisory: the softphone defers picking up the
-- row until preferred_until passes, giving the preferred rep first dibs.
-- After expiry, any available rep can claim it.

ALTER TABLE call_queue
  ADD COLUMN IF NOT EXISTS preferred_rep_id UUID REFERENCES reps(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS preferred_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS routing_category TEXT;

CREATE INDEX IF NOT EXISTS idx_call_queue_preferred
  ON call_queue (preferred_rep_id, preferred_until) WHERE status = 'waiting';

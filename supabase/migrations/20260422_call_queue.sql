-- 20260422: Per-rep + general call queue for WebRTC inbound routing.
-- Replaces the failed .online() push-registration path (SAT tokens
-- cannot register for incoming notifications on @signalwire/js v3.30).
-- Flow: sw-inbound <Enqueue>s caller into SignalWire queue AND inserts a
-- row here. Rep browser receives it via Supabase Realtime, shows ring,
-- clicks Answer → claims row → client.dial('queue:<name>') bridges them.

CREATE TABLE IF NOT EXISTS call_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_sid TEXT NOT NULL,
  from_number TEXT NOT NULL,
  caller_name TEXT,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  -- Queue identity passed to SignalWire <Enqueue> AND client.dial('queue:...').
  queue_name TEXT NOT NULL,
  -- If set, only this rep sees the ring. NULL = any available rep.
  target_rep_id UUID REFERENCES reps(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting','claimed','completed','abandoned')),
  claimed_by_rep_id UUID REFERENCES reps(id) ON DELETE SET NULL,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_call_queue_waiting
  ON call_queue (status, target_rep_id) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS idx_call_queue_call_sid
  ON call_queue (call_sid);

ALTER TABLE call_queue ENABLE ROW LEVEL SECURITY;

-- Reps see rows targeted at them OR untargeted (general queue).
DO $$ BEGIN
  CREATE POLICY call_queue_rep_select ON call_queue
    FOR SELECT TO authenticated
    USING (
      (SELECT (auth.jwt()->'app_metadata'->>'role') IN ('rep','admin'))
      AND (target_rep_id IS NULL OR target_rep_id = auth.uid())
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY call_queue_admin_all ON call_queue
    FOR ALL TO authenticated
    USING ((SELECT (auth.jwt()->'app_metadata'->>'role') = 'admin'))
    WITH CHECK ((SELECT (auth.jwt()->'app_metadata'->>'role') = 'admin'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Enable Realtime so rep browsers receive INSERT/UPDATE events.
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE call_queue;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

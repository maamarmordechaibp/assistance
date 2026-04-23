-- Persistent Browserbase context per customer + a log of every URL visited.
-- The "context" survives forever (cookies, logged-in sites, history) so the
-- next call resumes where the previous one left off. The "session" is only
-- alive while a rep is actively using the browser (charged per-minute).

CREATE TABLE IF NOT EXISTS customer_browser_contexts (
  customer_id      UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  bb_context_id    TEXT NOT NULL,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  last_used_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS customer_browser_sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  call_id          UUID REFERENCES calls(id) ON DELETE SET NULL,
  rep_id           UUID REFERENCES reps(id) ON DELETE SET NULL,
  bb_session_id    TEXT NOT NULL,
  bb_context_id    TEXT NOT NULL,
  connect_url      TEXT,
  live_url         TEXT,
  status           TEXT NOT NULL DEFAULT 'active', -- active | ended | error
  started_at       TIMESTAMPTZ DEFAULT NOW(),
  ended_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cbs_customer_active
  ON customer_browser_sessions (customer_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS customer_browser_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  session_id    UUID REFERENCES customer_browser_sessions(id) ON DELETE SET NULL,
  rep_id        UUID REFERENCES reps(id) ON DELETE SET NULL,
  url           TEXT NOT NULL,
  title         TEXT,
  visited_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cbh_customer ON customer_browser_history (customer_id, visited_at DESC);

ALTER TABLE customer_browser_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_browser_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_browser_history  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rep_full_access_cbc" ON customer_browser_contexts;
CREATE POLICY "rep_full_access_cbc" ON customer_browser_contexts
  FOR ALL USING (EXISTS (SELECT 1 FROM reps WHERE reps.id = auth.uid()));

DROP POLICY IF EXISTS "rep_full_access_cbs" ON customer_browser_sessions;
CREATE POLICY "rep_full_access_cbs" ON customer_browser_sessions
  FOR ALL USING (EXISTS (SELECT 1 FROM reps WHERE reps.id = auth.uid()));

DROP POLICY IF EXISTS "rep_full_access_cbh" ON customer_browser_history;
CREATE POLICY "rep_full_access_cbh" ON customer_browser_history
  FOR ALL USING (EXISTS (SELECT 1 FROM reps WHERE reps.id = auth.uid()));

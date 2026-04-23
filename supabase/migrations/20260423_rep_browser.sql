-- Personal browser sessions for reps (separate from per-customer sessions).
-- Each rep gets one persistent Browserbase context so their logins/cookies
-- (e.g. logged-in Amazon account, personal email) survive across sessions.

CREATE TABLE IF NOT EXISTS rep_browser_contexts (
  rep_id UUID PRIMARY KEY REFERENCES reps(id) ON DELETE CASCADE,
  bb_context_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rep_browser_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id UUID NOT NULL REFERENCES reps(id) ON DELETE CASCADE,
  bb_session_id TEXT NOT NULL,
  bb_context_id TEXT,
  connect_url TEXT,
  live_url TEXT,
  status TEXT DEFAULT 'active',   -- 'active' | 'ended'
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_rbs_rep ON rep_browser_sessions (rep_id, status, started_at DESC);

ALTER TABLE rep_browser_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE rep_browser_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rep_own_context" ON rep_browser_contexts;
CREATE POLICY "rep_own_context" ON rep_browser_contexts FOR ALL
  USING (rep_id = auth.uid()) WITH CHECK (rep_id = auth.uid());

DROP POLICY IF EXISTS "rep_own_session" ON rep_browser_sessions;
CREATE POLICY "rep_own_session" ON rep_browser_sessions FOR ALL
  USING (rep_id = auth.uid()) WITH CHECK (rep_id = auth.uid());

DROP POLICY IF EXISTS "service_role_rbc" ON rep_browser_contexts;
CREATE POLICY "service_role_rbc" ON rep_browser_contexts FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "service_role_rbs" ON rep_browser_sessions;
CREATE POLICY "service_role_rbs" ON rep_browser_sessions FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

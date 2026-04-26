-- Voicemails left via the IVR (e.g. press 4 → Yiddish admin office).
-- These are NOT call legs that were routed to a rep — they're stand-alone
-- recordings that an admin can listen to and read transcripts for.

CREATE TABLE IF NOT EXISTS voicemails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  caller_phone TEXT,
  mailbox TEXT NOT NULL DEFAULT 'yiddish',
  recording_sid TEXT,
  recording_url TEXT,
  recording_storage_path TEXT,
  transcript_text TEXT,
  duration_seconds INT,
  played_at TIMESTAMPTZ,
  played_by_rep_id UUID REFERENCES reps(id) ON DELETE SET NULL,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_voicemails_mailbox_created ON voicemails (mailbox, archived_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_voicemails_customer ON voicemails (customer_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_voicemails_recording_sid ON voicemails (recording_sid) WHERE recording_sid IS NOT NULL;

ALTER TABLE voicemails ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "voicemails_admin_all" ON voicemails;
CREATE POLICY "voicemails_admin_all" ON voicemails FOR ALL
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

DROP POLICY IF EXISTS "voicemails_service_role" ON voicemails;
CREATE POLICY "voicemails_service_role" ON voicemails FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

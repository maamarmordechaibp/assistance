-- Local Chrome profile sync for shared customer browsing.
--
-- The rep's PC runs `tools/offline-browser-launcher/launcher.ps1`. When a
-- rep clicks "Open Browser" on the customer panel:
--   1) The launcher calls the edge function `customer-browser-profile`
--      with action=acquire, which atomically takes a lock on the customer
--      and returns a signed URL to download the profile zip.
--   2) The launcher unzips into %LOCALAPPDATA%\OfflineBrowser\Profiles and
--      starts Chrome.
--   3) While Chrome runs, the launcher heart-beats every 60s.
--   4) On Chrome exit (or release), the launcher zips the trimmed profile,
--      uploads via signed URL, and calls action=release.
--
-- A second rep trying to acquire while a lock is held gets the holder's
-- name + a 409 (and an optional admin force-unlock).

-- 1) Private bucket for the profile blobs ───────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('customer-browser-profiles', 'customer-browser-profiles', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- Reps + service role can read/write objects scoped to this bucket; no public
-- access. The edge function actually uses the service role and signed URLs,
-- so these policies are mostly defence-in-depth.
DROP POLICY IF EXISTS "cbp_rep_read"   ON storage.objects;
DROP POLICY IF EXISTS "cbp_rep_write"  ON storage.objects;
DROP POLICY IF EXISTS "cbp_rep_update" ON storage.objects;
DROP POLICY IF EXISTS "cbp_rep_delete" ON storage.objects;

CREATE POLICY "cbp_rep_read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'customer-browser-profiles'
         AND EXISTS (SELECT 1 FROM reps WHERE reps.id = auth.uid()));

CREATE POLICY "cbp_rep_write" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'customer-browser-profiles'
              AND EXISTS (SELECT 1 FROM reps WHERE reps.id = auth.uid()));

CREATE POLICY "cbp_rep_update" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'customer-browser-profiles'
         AND EXISTS (SELECT 1 FROM reps WHERE reps.id = auth.uid()));

CREATE POLICY "cbp_rep_delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'customer-browser-profiles'
         AND EXISTS (SELECT 1 FROM reps WHERE reps.id = auth.uid()));

-- 2) Lock table — exactly one rep may hold a customer's profile at a time ─
CREATE TABLE IF NOT EXISTS customer_browser_profile_locks (
  customer_id        UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  holder_rep_id      UUID NOT NULL REFERENCES reps(id) ON DELETE CASCADE,
  holder_pc_hostname TEXT,
  acquired_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at         TIMESTAMPTZ NOT NULL,         -- pushed forward on heartbeat
  last_heartbeat_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lock_token         UUID NOT NULL DEFAULT gen_random_uuid()  -- proves identity on release/upload
);

CREATE INDEX IF NOT EXISTS idx_cbpl_holder ON customer_browser_profile_locks (holder_rep_id);
CREATE INDEX IF NOT EXISTS idx_cbpl_expires ON customer_browser_profile_locks (expires_at);

-- 3) Audit log — every acquire / release / force-unlock for compliance ───
CREATE TABLE IF NOT EXISTS customer_browser_profile_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  rep_id          UUID REFERENCES reps(id) ON DELETE SET NULL,
  pc_hostname     TEXT,
  action          TEXT NOT NULL CHECK (action IN
                    ('acquire','release','heartbeat','force_unlock','upload','download','blocked')),
  detail          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cbpe_customer ON customer_browser_profile_events (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cbpe_rep      ON customer_browser_profile_events (rep_id, created_at DESC);

-- 4) Profile metadata — last upload size, version, etc. ─────────────────
CREATE TABLE IF NOT EXISTS customer_browser_profile_blobs (
  customer_id        UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  last_uploaded_at   TIMESTAMPTZ,
  last_uploaded_by   UUID REFERENCES reps(id) ON DELETE SET NULL,
  size_bytes         BIGINT,
  chrome_version     TEXT,
  storage_path       TEXT NOT NULL
);

ALTER TABLE customer_browser_profile_locks  ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_browser_profile_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_browser_profile_blobs  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cbpl_rep_all" ON customer_browser_profile_locks;
CREATE POLICY "cbpl_rep_all" ON customer_browser_profile_locks
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM reps WHERE reps.id = auth.uid()));

DROP POLICY IF EXISTS "cbpe_rep_all" ON customer_browser_profile_events;
CREATE POLICY "cbpe_rep_all" ON customer_browser_profile_events
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM reps WHERE reps.id = auth.uid()));

DROP POLICY IF EXISTS "cbpb_rep_all" ON customer_browser_profile_blobs;
CREATE POLICY "cbpb_rep_all" ON customer_browser_profile_blobs
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM reps WHERE reps.id = auth.uid()));

-- 5) Atomic acquire helper. Used by the edge function under service role:
--    SELECT * FROM acquire_customer_browser_profile_lock(:customer_id, :rep_id, :hostname, :ttl_seconds);
-- Returns the (possibly existing) lock row. Clears stale locks first.
CREATE OR REPLACE FUNCTION acquire_customer_browser_profile_lock(
  p_customer_id UUID,
  p_rep_id      UUID,
  p_hostname    TEXT,
  p_ttl_seconds INT DEFAULT 600
) RETURNS customer_browser_profile_locks
LANGUAGE plpgsql AS $$
DECLARE
  v_row customer_browser_profile_locks;
BEGIN
  -- Drop any expired lock first.
  DELETE FROM customer_browser_profile_locks
   WHERE customer_id = p_customer_id
     AND expires_at < NOW();

  -- Try to insert; ON CONFLICT means someone else already holds it.
  INSERT INTO customer_browser_profile_locks
    (customer_id, holder_rep_id, holder_pc_hostname, acquired_at, expires_at, last_heartbeat_at)
  VALUES
    (p_customer_id, p_rep_id, p_hostname, NOW(),
     NOW() + (p_ttl_seconds || ' seconds')::interval, NOW())
  ON CONFLICT (customer_id) DO UPDATE
     SET acquired_at      = CASE WHEN customer_browser_profile_locks.holder_rep_id = p_rep_id
                                 THEN customer_browser_profile_locks.acquired_at
                                 ELSE customer_browser_profile_locks.acquired_at END,
         -- Re-acquire by same rep extends the lock; different rep is rejected
         -- below by the caller comparing holder_rep_id.
         expires_at       = CASE WHEN customer_browser_profile_locks.holder_rep_id = p_rep_id
                                 THEN NOW() + (p_ttl_seconds || ' seconds')::interval
                                 ELSE customer_browser_profile_locks.expires_at END,
         last_heartbeat_at = CASE WHEN customer_browser_profile_locks.holder_rep_id = p_rep_id
                                  THEN NOW()
                                  ELSE customer_browser_profile_locks.last_heartbeat_at END
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- Extend customer_credentials so we can record passwords/cookies captured
-- automatically from the synced Chrome profile (launcher.ps1 reads
-- Chrome's `Login Data` SQLite file on profile upload, decrypts using DPAPI
-- on the rep's PC, then POSTs to the `customer-browser-profile` edge
-- function which re-encrypts via Supabase Vault and upserts here).
--
-- Existing manually-entered credentials still work — `source = 'manual'`
-- is the default.

ALTER TABLE customer_credentials
  ADD COLUMN IF NOT EXISTS source         TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual','browser_capture','imported')),
  ADD COLUMN IF NOT EXISTS origin_url     TEXT,             -- "https://amazon.com"
  ADD COLUMN IF NOT EXISTS signon_realm   TEXT,             -- Chrome's realm (usually = origin)
  ADD COLUMN IF NOT EXISTS captured_by_rep_id UUID REFERENCES reps(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS captured_at    TIMESTAMPTZ;

-- Make upsert-by-(customer, service, username) deterministic. Captures with
-- the same triple update in place; new triples get a fresh row.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_customer_credentials_triple
  ON customer_credentials (customer_id, COALESCE(service_name,''), COALESCE(username,''));

CREATE INDEX IF NOT EXISTS idx_customer_credentials_origin
  ON customer_credentials (origin_url) WHERE origin_url IS NOT NULL;

-- Server-side encrypt + upsert helper. The plaintext only ever crosses the
-- wire from the launcher → edge function (HTTPS), then this function
-- inside the database; the cleartext is never stored.
--
-- Encryption uses pgcrypto's pgp_sym_encrypt with a key from
-- `app_settings.credential_encryption_key`. If pgcrypto isn't installed,
-- we error out rather than store cleartext.
--
-- Set the key once (per environment) with:
--   ALTER DATABASE postgres SET app.credential_encryption_key = '<32-byte secret>';
-- or via Supabase: Project Settings → Database → Custom config.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Extend the existing credential_access_log so it can record automatic
-- captures and reads (which aren't tied to a specific call).
DO $$ BEGIN
  ALTER TYPE credential_action ADD VALUE IF NOT EXISTS 'capture';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TYPE credential_action ADD VALUE IF NOT EXISTS 'read';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE credential_access_log
  ALTER COLUMN call_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION upsert_captured_credential(
  p_customer_id  UUID,
  p_rep_id       UUID,
  p_service_name TEXT,
  p_username     TEXT,
  p_password     TEXT,
  p_origin_url   TEXT,
  p_signon_realm TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_key  TEXT;
  v_id   UUID;
BEGIN
  v_key := current_setting('app.credential_encryption_key', true);
  IF v_key IS NULL OR length(v_key) < 16 THEN
    RAISE EXCEPTION 'app.credential_encryption_key not set or too short';
  END IF;

  INSERT INTO customer_credentials (
    customer_id, service_name, username,
    encrypted_password, origin_url, signon_realm,
    source, captured_by_rep_id, captured_at,
    last_accessed_at, last_accessed_by
  ) VALUES (
    p_customer_id, p_service_name, p_username,
    pgp_sym_encrypt(p_password, v_key), p_origin_url, p_signon_realm,
    'browser_capture', p_rep_id, NOW(),
    NOW(), p_rep_id
  )
  ON CONFLICT (customer_id, COALESCE(service_name,''), COALESCE(username,''))
  DO UPDATE SET
    encrypted_password = pgp_sym_encrypt(p_password, v_key),
    origin_url         = COALESCE(EXCLUDED.origin_url, customer_credentials.origin_url),
    signon_realm       = COALESCE(EXCLUDED.signon_realm, customer_credentials.signon_realm),
    captured_by_rep_id = p_rep_id,
    captured_at        = NOW(),
    updated_at         = NOW()
  RETURNING id INTO v_id;

  -- Audit (best-effort; never block the upsert on log failures).
  BEGIN
    INSERT INTO credential_access_log (credential_id, rep_id, action, accessed_at)
    VALUES (v_id, p_rep_id, 'capture', NOW());
  EXCEPTION WHEN OTHERS THEN /* ignore */ END;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION upsert_captured_credential(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION upsert_captured_credential(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;

-- Decryption helper for reps reading credentials in the dashboard.
-- Logs every access automatically.
CREATE OR REPLACE FUNCTION read_customer_credential(p_credential_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_key       TEXT;
  v_plaintext TEXT;
  v_caller    UUID;
BEGIN
  v_key := current_setting('app.credential_encryption_key', true);
  IF v_key IS NULL OR length(v_key) < 16 THEN
    RAISE EXCEPTION 'app.credential_encryption_key not set';
  END IF;

  v_caller := auth.uid();
  IF v_caller IS NULL OR NOT EXISTS (SELECT 1 FROM reps WHERE id = v_caller) THEN
    RAISE EXCEPTION 'rep only';
  END IF;

  SELECT pgp_sym_decrypt(encrypted_password, v_key) INTO v_plaintext
  FROM customer_credentials WHERE id = p_credential_id;

  UPDATE customer_credentials
     SET last_accessed_at = NOW(), last_accessed_by = v_caller
   WHERE id = p_credential_id;

  BEGIN
    INSERT INTO credential_access_log (credential_id, rep_id, action, accessed_at)
    VALUES (p_credential_id, v_caller, 'read', NOW());
  EXCEPTION WHEN OTHERS THEN /* ignore */ END;

  RETURN v_plaintext;
END;
$$;

REVOKE ALL ON FUNCTION read_customer_credential(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_customer_credential(UUID) TO authenticated;

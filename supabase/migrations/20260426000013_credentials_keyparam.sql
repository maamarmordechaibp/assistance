-- Follow-up: ALTER DATABASE SET … is blocked for the postgres user on
-- Supabase managed projects, so we cannot set
-- `app.credential_encryption_key` once and let the RPCs read it via
-- `current_setting()`.
--
-- Replace the two RPCs with versions that take the encryption key as a
-- parameter. The edge functions pass the key from a Supabase secret env
-- var (`CREDENTIAL_ENCRYPTION_KEY`), so the cleartext key is never
-- persisted and never reachable from a SQL session that doesn't already
-- have it.

DROP FUNCTION IF EXISTS upsert_captured_credential(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS read_customer_credential(UUID);

CREATE OR REPLACE FUNCTION upsert_captured_credential(
  p_customer_id  UUID,
  p_rep_id       UUID,
  p_service_name TEXT,
  p_username     TEXT,
  p_password     TEXT,
  p_origin_url   TEXT,
  p_signon_realm TEXT,
  p_enc_key      TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF p_enc_key IS NULL OR length(p_enc_key) < 16 THEN
    RAISE EXCEPTION 'enc key missing or too short';
  END IF;

  INSERT INTO customer_credentials (
    customer_id, service_name, username,
    encrypted_password, origin_url, signon_realm,
    source, captured_by_rep_id, captured_at,
    last_accessed_at, last_accessed_by
  ) VALUES (
    p_customer_id, p_service_name, p_username,
    pgp_sym_encrypt(p_password, p_enc_key), p_origin_url, p_signon_realm,
    'browser_capture', p_rep_id, NOW(),
    NOW(), p_rep_id
  )
  ON CONFLICT (customer_id, COALESCE(service_name,''), COALESCE(username,''))
  DO UPDATE SET
    encrypted_password = pgp_sym_encrypt(p_password, p_enc_key),
    origin_url         = COALESCE(EXCLUDED.origin_url, customer_credentials.origin_url),
    signon_realm       = COALESCE(EXCLUDED.signon_realm, customer_credentials.signon_realm),
    captured_by_rep_id = p_rep_id,
    captured_at        = NOW(),
    updated_at         = NOW()
  RETURNING id INTO v_id;

  BEGIN
    INSERT INTO credential_access_log (credential_id, rep_id, action, accessed_at)
    VALUES (v_id, p_rep_id, 'capture', NOW());
  EXCEPTION WHEN OTHERS THEN /* ignore */ END;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION upsert_captured_credential(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION upsert_captured_credential(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;


CREATE OR REPLACE FUNCTION read_customer_credential(
  p_credential_id UUID,
  p_enc_key       TEXT
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_plaintext TEXT;
  v_caller    UUID;
BEGIN
  IF p_enc_key IS NULL OR length(p_enc_key) < 16 THEN
    RAISE EXCEPTION 'enc key missing or too short';
  END IF;

  v_caller := auth.uid();
  IF v_caller IS NULL OR NOT EXISTS (SELECT 1 FROM reps WHERE id = v_caller) THEN
    RAISE EXCEPTION 'rep only';
  END IF;

  SELECT pgp_sym_decrypt(encrypted_password, p_enc_key) INTO v_plaintext
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

REVOKE ALL ON FUNCTION read_customer_credential(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_customer_credential(UUID, TEXT) TO service_role;

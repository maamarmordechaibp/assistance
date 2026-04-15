-- ============================================
-- 011: Credential access log (audit trail)
-- ============================================

CREATE TYPE credential_action AS ENUM ('view', 'copy');

CREATE TABLE credential_access_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id UUID NOT NULL REFERENCES customer_credentials(id) ON DELETE CASCADE,
  rep_id UUID NOT NULL REFERENCES reps(id) ON DELETE CASCADE,
  call_id UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  action credential_action NOT NULL,
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_credential_access_log_credential ON credential_access_log (credential_id);
CREATE INDEX idx_credential_access_log_rep ON credential_access_log (rep_id);

-- ============================================
-- Auto-assigned per-customer email under our domain
-- ============================================
-- Each customer gets a synthetic, offline-controlled email address used as
-- the username/login on third-party platforms (Amazon, banks, etc.) so all
-- account-confirmation, OTP, and shipping-tracking mail can be received and
-- attributed to the right customer via Resend inbound (set up separately —
-- see EDGE_FUNCTIONS.md for the Resend webhook configuration).
--
-- The customer's own personal email remains in `customers.email`. The
-- auto-generated address lives in `customers.assigned_email`.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS assigned_email TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_customers_assigned_email
  ON customers (assigned_email)
  WHERE assigned_email IS NOT NULL;

-- Format: <digits-only phone>@offlinesbrowse.com
-- Example: +1 (718) 635-3661  →  17186353661@offlinesbrowse.com
-- If primary_phone has no digits (shouldn't happen — column is NOT NULL),
-- fall back to the customer UUID short form so we still get something unique.
CREATE OR REPLACE FUNCTION assign_customer_email()
RETURNS TRIGGER AS $$
DECLARE
  digits TEXT;
  candidate TEXT;
BEGIN
  IF NEW.assigned_email IS NOT NULL AND length(trim(NEW.assigned_email)) > 0 THEN
    RETURN NEW;
  END IF;

  digits := regexp_replace(coalesce(NEW.primary_phone, ''), '[^0-9]', '', 'g');
  IF length(digits) = 0 THEN
    digits := replace(NEW.id::text, '-', '');
  END IF;

  candidate := digits || '@offlinesbrowse.com';

  -- If another customer already has this address (e.g. duplicate phone — rare
  -- given the dedupe migration but defensively handled), suffix with a short
  -- UUID slice so we never violate the unique index.
  IF EXISTS (SELECT 1 FROM customers WHERE assigned_email = candidate AND id <> NEW.id) THEN
    candidate := digits || '-' || substr(replace(NEW.id::text, '-', ''), 1, 6) || '@offlinesbrowse.com';
  END IF;

  NEW.assigned_email := candidate;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_assign_customer_email ON customers;
CREATE TRIGGER trg_assign_customer_email
  BEFORE INSERT OR UPDATE OF primary_phone, assigned_email ON customers
  FOR EACH ROW
  EXECUTE FUNCTION assign_customer_email();

-- Backfill existing rows.
UPDATE customers
SET assigned_email = NULL
WHERE assigned_email IS NULL;
-- (the trigger fires on UPDATE only when the listed columns change; force
--  population with a direct UPDATE instead.)

UPDATE customers c
SET assigned_email = COALESCE(
  c.assigned_email,
  CASE
    WHEN length(regexp_replace(coalesce(c.primary_phone, ''), '[^0-9]', '', 'g')) > 0
      THEN regexp_replace(c.primary_phone, '[^0-9]', '', 'g') || '@offlinesbrowse.com'
    ELSE replace(c.id::text, '-', '') || '@offlinesbrowse.com'
  END
)
WHERE c.assigned_email IS NULL;

-- Resolve any duplicate backfills (same phone) by suffixing with id slice.
WITH dupes AS (
  SELECT id, assigned_email,
         row_number() OVER (PARTITION BY assigned_email ORDER BY created_at) AS rn
  FROM customers
  WHERE assigned_email IS NOT NULL
)
UPDATE customers c
SET assigned_email =
  split_part(d.assigned_email, '@', 1)
  || '-' || substr(replace(c.id::text, '-', ''), 1, 6)
  || '@' || split_part(d.assigned_email, '@', 2)
FROM dupes d
WHERE c.id = d.id AND d.rn > 1;

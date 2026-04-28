-- Phase 2 of customer self-serve tracking: capture the customer's *personal*
-- email (i.e. the Gmail / iCloud / Yahoo address they actually own), separate
-- from `assigned_email` (the auto-issued <phone>@offlinesbrowse.com mailbox
-- our reps use to register accounts on the customer's behalf).
--
-- Why we need both: when a customer brings an existing merchant account
-- (say, an Amazon login on their personal Gmail), reps walk them through
-- adding a Gmail forwarding filter that pushes shipping/order confirmations
-- to their assigned mailbox. We track verification by watching for the first
-- merchant email whose `from` matches a known merchant domain AND the
-- recipient row resolves to a customer with `personal_email IS NOT NULL`.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS personal_email TEXT,
  ADD COLUMN IF NOT EXISTS forwarding_verified_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_customers_personal_email
  ON customers (lower(personal_email))
  WHERE personal_email IS NOT NULL;

COMMENT ON COLUMN customers.personal_email IS
  'Customer''s real email address (Gmail/iCloud/etc). Distinct from assigned_email which is the synthetic <phone>@offlinesbrowse.com mailbox we issue.';
COMMENT ON COLUMN customers.forwarding_verified_at IS
  'Set when we observe an inbound merchant email reaching this customer''s assigned mailbox after personal_email was on file. Indicates Gmail forwarding has been set up by the customer.';

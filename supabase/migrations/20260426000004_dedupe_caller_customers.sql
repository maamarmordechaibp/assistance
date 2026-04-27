-- ============================================
-- 20260426000004: Dedupe auto-created "Caller …" customers
-- ============================================
--
-- A bug in sw-inbound / sw-account-lookup / sw-callback-choice used
-- PostgREST `.or('primary_phone.eq.+1…')` filters. PostgREST does not
-- URL-encode the value inside an `.or()` expression, so the leading `+`
-- of an E.164 number was decoded server-side as a space and the lookup
-- never matched the existing row. As a result every inbound call from
-- the same number created a brand-new auto-named `Caller +1…` customer.
--
-- This migration:
--   1. Merges all auto-created stub customers (full_name LIKE 'Caller %')
--      that share a primary_phone, keeping the oldest row and re-pointing
--      child rows (calls, callback_requests, payments, ledger, etc.) to it.
--   2. Adds a partial UNIQUE index on primary_phone for stub rows so the
--      bug cannot resurface even if the application code regresses.
-- ============================================

BEGIN;

-- 1. Pick the surviving (oldest) stub per phone number.
WITH ranked AS (
  SELECT
    id,
    primary_phone,
    ROW_NUMBER() OVER (
      PARTITION BY primary_phone
      ORDER BY created_at ASC, id ASC
    ) AS rn,
    FIRST_VALUE(id) OVER (
      PARTITION BY primary_phone
      ORDER BY created_at ASC, id ASC
    ) AS keeper_id
  FROM customers
  WHERE full_name LIKE 'Caller %'
),
duplicates AS (
  SELECT id AS dup_id, keeper_id
  FROM ranked
  WHERE rn > 1
)
-- 2. Re-point every child table that references customers.id.
--    Each UPDATE is wrapped in a DO block so the migration succeeds even
--    if a particular table doesn't exist in this environment.
SELECT 1;  -- no-op anchor for the CTE above

DO $$
DECLARE
  r RECORD;
  child RECORD;
  -- list of (table, column) pairs that reference customers(id)
  child_tables TEXT[][] := ARRAY[
    ['calls',                'customer_id'],
    ['call_analyses',        'customer_id'],
    ['minute_ledger',        'customer_id'],
    ['payments',             'customer_id'],
    ['callback_requests',    'customer_id'],
    ['customer_credentials', 'customer_id'],
    ['credential_access_log','customer_id'],
    ['withdrawals',          'customer_id'],
    ['saved_payment_methods','customer_id'],
    ['product_searches',     'customer_id'],
    ['customer_browser_sessions','customer_id'],
    ['voicemails',           'customer_id'],
    ['call_traces',          'customer_id']
  ];
  i INT;
BEGIN
  -- Build a temp table of (dup_id, keeper_id) pairs.
  CREATE TEMP TABLE _dupes ON COMMIT DROP AS
  WITH ranked AS (
    SELECT
      id,
      primary_phone,
      ROW_NUMBER() OVER (
        PARTITION BY primary_phone
        ORDER BY created_at ASC, id ASC
      ) AS rn,
      FIRST_VALUE(id) OVER (
        PARTITION BY primary_phone
        ORDER BY created_at ASC, id ASC
      ) AS keeper_id
    FROM customers
    WHERE full_name LIKE 'Caller %'
  )
  SELECT id AS dup_id, keeper_id
  FROM ranked
  WHERE rn > 1;

  -- Re-point children for each known child table that exists.
  FOR i IN 1 .. array_length(child_tables, 1) LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = child_tables[i][1]
        AND column_name  = child_tables[i][2]
    ) THEN
      EXECUTE format(
        'UPDATE %I SET %I = d.keeper_id
           FROM _dupes d
          WHERE %I.%I = d.dup_id',
        child_tables[i][1], child_tables[i][2],
        child_tables[i][1], child_tables[i][2]
      );
    END IF;
  END LOOP;

  -- Roll the financial counters from the duplicates into the keeper so we
  -- don't lose any history (most stubs are zero anyway, but be safe).
  UPDATE customers k
     SET current_balance_minutes  = k.current_balance_minutes  + s.bal,
         total_minutes_purchased  = k.total_minutes_purchased  + s.bought,
         total_minutes_used       = k.total_minutes_used       + s.used
    FROM (
      SELECT d.keeper_id,
             COALESCE(SUM(c.current_balance_minutes), 0) AS bal,
             COALESCE(SUM(c.total_minutes_purchased), 0) AS bought,
             COALESCE(SUM(c.total_minutes_used), 0)      AS used
        FROM _dupes d
        JOIN customers c ON c.id = d.dup_id
       GROUP BY d.keeper_id
    ) s
   WHERE k.id = s.keeper_id;

  -- Finally delete the now-orphaned duplicate stubs.
  DELETE FROM customers
   WHERE id IN (SELECT dup_id FROM _dupes);
END $$;

-- 3. Prevent it from ever happening again at the DB level.
--    Only one auto-created stub per phone number is allowed; named
--    customers are intentionally exempt (reps may legitimately add
--    family members sharing a phone).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_customers_stub_primary_phone
  ON customers (primary_phone)
  WHERE full_name LIKE 'Caller %';

COMMIT;

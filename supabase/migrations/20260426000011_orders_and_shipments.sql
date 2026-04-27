-- Orders, shipments, and tracking events.
--
-- An "order" is a single purchase a rep placed on behalf of a customer.
-- One order can have multiple shipments (e.g. backorders, split shipping).
-- Each shipment accumulates "tracking events" pulled from carrier APIs.
--
-- The IVR (sw-order-status) reads from these tables to read tracking info to
-- the customer over the phone.

-- 1) Orders ─────────────────────────────────────────────────────────────
CREATE TYPE order_status AS ENUM (
  'placed',     -- order submitted, no payment confirmation yet
  'paid',       -- merchant accepted payment
  'shipped',    -- at least one shipment has tracking
  'delivered',  -- all shipments delivered
  'cancelled',
  'refunded'
);

CREATE TABLE IF NOT EXISTS orders (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  rep_id             UUID REFERENCES reps(id) ON DELETE SET NULL,
  call_id            UUID REFERENCES calls(id) ON DELETE SET NULL,
  merchant_name      TEXT NOT NULL,
  merchant_url       TEXT,
  merchant_order_id  TEXT,                       -- order # from the merchant's system
  item_summary       TEXT NOT NULL,              -- short human-readable: "Apple AirPods Pro 2"
  item_count         INT,
  total_amount       NUMERIC(12,2),
  currency           TEXT DEFAULT 'USD',
  status             order_status NOT NULL DEFAULT 'placed',
  ordered_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  internal_notes     TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_customer  ON orders (customer_id, ordered_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_rep       ON orders (rep_id);
CREATE INDEX IF NOT EXISTS idx_orders_status    ON orders (status);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_orders_merchant_orderid
  ON orders (merchant_name, merchant_order_id)
  WHERE merchant_order_id IS NOT NULL;

CREATE TRIGGER trg_orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 2) Shipments ──────────────────────────────────────────────────────────
CREATE TYPE shipment_status AS ENUM (
  'pending',          -- shipment row exists, no tracking yet
  'label_created',    -- carrier has accepted manifest, not yet picked up
  'in_transit',
  'out_for_delivery',
  'delivered',
  'exception',        -- delivery problem (address invalid, damaged, etc.)
  'returned'
);

CREATE TABLE IF NOT EXISTS order_shipments (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                 UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  carrier                  TEXT,                  -- 'ups' | 'fedex' | 'usps' | 'dhl' | merchant-specific
  tracking_number          TEXT,
  tracking_url             TEXT,
  status                   shipment_status NOT NULL DEFAULT 'pending',
  estimated_delivery_date  DATE,
  actual_delivery_date     DATE,
  last_status_check_at     TIMESTAMPTZ,
  last_status_message      TEXT,                  -- "Out for delivery — Brooklyn, NY"
  raw_carrier_payload      JSONB,                 -- last full carrier response (for debugging)
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shipments_order   ON order_shipments (order_id);
CREATE INDEX IF NOT EXISTS idx_shipments_track   ON order_shipments (tracking_number) WHERE tracking_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shipments_active  ON order_shipments (status, last_status_check_at)
  WHERE status NOT IN ('delivered','returned');

CREATE TRIGGER trg_shipments_updated_at
  BEFORE UPDATE ON order_shipments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 3) Tracking events (history; each row is a scan / status transition) ──
CREATE TABLE IF NOT EXISTS order_tracking_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id     UUID NOT NULL REFERENCES order_shipments(id) ON DELETE CASCADE,
  occurred_at     TIMESTAMPTZ NOT NULL,
  location        TEXT,
  description     TEXT,
  status_code     TEXT,
  raw             JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tracking_events_shipment ON order_tracking_events (shipment_id, occurred_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tracking_events_dedupe
  ON order_tracking_events (shipment_id, occurred_at, status_code);

-- 4) RLS — reps + admins can do everything; customers see nothing directly
ALTER TABLE orders                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_shipments         ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_tracking_events   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "orders_rep_all" ON orders;
CREATE POLICY "orders_rep_all" ON orders FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM reps WHERE reps.id = auth.uid()));

DROP POLICY IF EXISTS "shipments_rep_all" ON order_shipments;
CREATE POLICY "shipments_rep_all" ON order_shipments FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM reps WHERE reps.id = auth.uid()));

DROP POLICY IF EXISTS "tracking_events_rep_all" ON order_tracking_events;
CREATE POLICY "tracking_events_rep_all" ON order_tracking_events FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM reps WHERE reps.id = auth.uid()));

-- 5) Helper view: latest shipment per order (handy in IVR + UI) ─────────
CREATE OR REPLACE VIEW v_order_latest_shipment AS
SELECT DISTINCT ON (o.id)
  o.id                       AS order_id,
  o.customer_id              AS customer_id,
  o.merchant_name            AS merchant_name,
  o.item_summary             AS item_summary,
  o.status                   AS order_status,
  s.id                       AS shipment_id,
  s.carrier                  AS carrier,
  s.tracking_number          AS tracking_number,
  s.status                   AS shipment_status,
  s.estimated_delivery_date  AS estimated_delivery_date,
  s.actual_delivery_date     AS actual_delivery_date,
  s.last_status_message      AS last_status_message
FROM orders o
LEFT JOIN order_shipments s ON s.order_id = o.id
ORDER BY o.id, s.created_at DESC NULLS LAST;

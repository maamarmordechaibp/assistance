// Convert a stored `customer_emails` row into upserted `orders` +
// `order_shipments` rows. Idempotent: re-running on the same email is a
// no-op aside from refreshing tracking carrier data.
//
// Used by:
//   - email-inbound (real-time, after the email row is stored)
//   - email-classify-backfill (one-shot rescan of historical rows)

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.103.0';
import { detectCarrier, refreshShipment } from './tracking.ts';
import { planIngest, type IngestPlan } from './email-classify.ts';

type Svc = SupabaseClient;

export interface IngestResult {
  /** Whether the email looked like a merchant order/shipment at all. */
  matched: boolean;
  plan: IngestPlan;
  orderId?: string;
  shipmentIds?: string[];
  /** Reason if we didn't ingest (no merchant, no customer, etc.) */
  skipReason?: string;
}

interface EmailRow {
  id: string;
  customer_id: string | null;
  from_address: string | null;
  subject: string | null;
  text_body: string | null;
  html_body: string | null;
  received_at: string | null;
  raw_payload: Record<string, unknown> | null;
}

export async function ingestEmailAsOrder(
  svc: Svc,
  email: EmailRow,
  opts: { runCarrierRefresh?: boolean } = {},
): Promise<IngestResult> {
  const { runCarrierRefresh = false } = opts;

  const headersObj = extractHeaders(email.raw_payload);
  const plan = planIngest(
    email.from_address,
    email.subject,
    email.text_body,
    email.html_body,
    headersObj,
  );

  // Need a customer to attach the order to. Without one we can't proceed.
  if (!email.customer_id) {
    return { matched: false, plan, skipReason: 'no_customer' };
  }

  // Need either a merchant signature OR at least one tracking number to
  // create something useful.
  if (!plan.merchant && plan.trackings.length === 0) {
    return { matched: false, plan, skipReason: 'no_merchant_or_tracking' };
  }

  // Require an actionable intent. Order-confirmations / shipping-notifications
  // / delivery-notifications all warrant a row. Plain marketing or "your
  // refund was processed" doesn't.
  const actionable =
    plan.intent === 'order_confirmation' ||
    plan.intent === 'shipping_notification' ||
    plan.intent === 'delivery_notification' ||
    plan.trackings.length > 0;
  if (!actionable) {
    return { matched: false, plan, skipReason: 'intent_not_actionable' };
  }

  // ── Find or create the order ─────────────────────────────────────
  let orderId: string | null = null;

  if (plan.merchant && plan.merchantOrderId) {
    const { data: existing } = await svc
      .from('orders')
      .select('id')
      .eq('merchant_name', plan.merchant)
      .eq('merchant_order_id', plan.merchantOrderId)
      .maybeSingle();
    if (existing) orderId = existing.id;
  }

  if (!orderId && plan.merchant && plan.trackings[0]) {
    // Already-tracked shipment in DB? Reuse its order to avoid duplicates.
    const { data: shipMatch } = await svc
      .from('order_shipments')
      .select('order_id')
      .eq('tracking_number', plan.trackings[0].number)
      .maybeSingle();
    if (shipMatch) orderId = shipMatch.order_id;
  }

  if (!orderId) {
    const { data: inserted, error } = await svc
      .from('orders')
      .insert({
        customer_id: email.customer_id,
        merchant_name: plan.merchant ?? 'unknown',
        merchant_order_id: plan.merchantOrderId,
        item_summary: plan.itemSummary || (plan.merchant ? `${capitalize(plan.merchant)} order` : 'Inbound order'),
        status: shipmentStatusToOrderStatus(plan.intent),
        ordered_at: email.received_at || new Date().toISOString(),
      })
      .select('id')
      .maybeSingle();
    if (error || !inserted) {
      return { matched: false, plan, skipReason: `order_insert_failed:${error?.message ?? 'unknown'}` };
    }
    orderId = inserted.id;
  }

  // ── Upsert shipments per tracking number found ───────────────────
  const shipmentIds: string[] = [];
  for (const t of plan.trackings) {
    const carrier = t.carrier === 'unknown' ? detectCarrier(t.number) : t.carrier;
    const carrierForDb = carrier === 'unknown' ? null : carrier;

    const { data: existingShip } = await svc
      .from('order_shipments')
      .select('id, status')
      .eq('order_id', orderId)
      .eq('tracking_number', t.number)
      .maybeSingle();

    let shipmentId: string;
    if (existingShip) {
      shipmentId = existingShip.id;
    } else {
      const { data: newShip, error } = await svc
        .from('order_shipments')
        .insert({
          order_id: orderId,
          carrier: carrierForDb,
          tracking_number: t.number,
          tracking_url: t.url ?? null,
          status: plan.intent === 'delivery_notification' ? 'delivered' : 'pending',
        })
        .select('id')
        .maybeSingle();
      if (error || !newShip) {
        // Skip this tracking number but keep going for the rest.
        console.warn('[ingest] shipment insert failed:', error?.message);
        continue;
      }
      shipmentId = newShip.id;
    }
    shipmentIds.push(shipmentId);

    if (runCarrierRefresh) {
      try {
        await refreshShipment(svc, shipmentId);
      } catch (err) {
        console.warn('[ingest] refreshShipment failed:', err instanceof Error ? err.message : err);
      }
    }
  }

  // Bump order status when shipments exist or delivered.
  if (shipmentIds.length > 0) {
    const target = plan.intent === 'delivery_notification' ? 'delivered' : 'shipped';
    await svc.from('orders').update({ status: target }).eq('id', orderId);
  }

  return { matched: true, plan, orderId, shipmentIds };
}

function shipmentStatusToOrderStatus(intent: IngestPlan['intent']): string {
  switch (intent) {
    case 'delivery_notification': return 'delivered';
    case 'shipping_notification': return 'shipped';
    case 'order_confirmation':    return 'placed';
    case 'cancellation':          return 'cancelled';
    case 'return':                return 'refunded';
    default:                      return 'placed';
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function extractHeaders(rawPayload: Record<string, unknown> | null): Record<string, string> | null {
  if (!rawPayload) return null;
  const candidates = [
    rawPayload['headers'],
    (rawPayload['data'] as Record<string, unknown> | undefined)?.['headers'],
  ];
  for (const c of candidates) {
    if (c && typeof c === 'object' && !Array.isArray(c)) {
      return Object.fromEntries(
        Object.entries(c as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      );
    }
  }
  return null;
}

// Edge Function: orders
// CRUD for customer orders + their shipments + tracking events.
//
//   GET  ?customerId=…              → list orders + latest shipment
//   GET  ?orderId=…                 → one order + all shipments + events
//   POST { customerId, merchant_name, item_summary, ... }            → create order
//   POST action='attach-tracking', { orderId, carrier, tracking_number,
//                                    estimated_delivery_date? }      → add shipment
//   POST action='set-status',     { orderId, status }
//   POST action='refresh-shipment', { shipmentId }                   → poll carrier
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createUserClient, createServiceClient, getUser } from '../_shared/supabase.ts';
import { refreshShipment } from '../_shared/tracking.ts';

function jres(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const user = await getUser(req);
  if (!user) return jres({ error: 'unauthorized' }, 401);
  const userClient = createUserClient(req);
  const { data: rep } = await userClient.from('reps').select('id').eq('id', user.id).maybeSingle();
  if (!rep) return jres({ error: 'rep only' }, 403);
  const svc = createServiceClient();
  const url = new URL(req.url);

  try {
    if (req.method === 'GET') {
      const orderId = url.searchParams.get('orderId');
      if (orderId) {
        const { data: order } = await svc.from('orders').select('*').eq('id', orderId).maybeSingle();
        if (!order) return jres({ error: 'not found' }, 404);
        const { data: shipments } = await svc.from('order_shipments')
          .select('*').eq('order_id', orderId).order('created_at', { ascending: false });
        const ids = (shipments || []).map((s: { id: string }) => s.id);
        const { data: events } = ids.length
          ? await svc.from('order_tracking_events').select('*').in('shipment_id', ids).order('occurred_at', { ascending: false })
          : { data: [] as unknown[] };
        return jres({ order, shipments: shipments || [], events: events || [] });
      }
      const shipmentId = url.searchParams.get('shipmentId');
      if (shipmentId && url.searchParams.get('includeEvents')) {
        const { data: events } = await svc.from('order_tracking_events')
          .select('*').eq('shipment_id', shipmentId).order('occurred_at', { ascending: false });
        return jres({ events: events || [] });
      }
      const customerId = url.searchParams.get('customerId');
      if (!customerId) return jres({ error: 'customerId or orderId required' }, 400);
      const { data: rows } = await svc.from('v_order_latest_shipment')
        .select('*').eq('customer_id', customerId).order('ordered_at', { ascending: false, nullsFirst: false });
      return jres({ orders: rows || [] });
    }

    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const action = body.action || '';

      if (action === 'attach-tracking') {
        const orderId = body.orderId;
        const carrier = body.carrier;
        const tracking_number = body.tracking_number ?? body.trackingNumber;
        const tracking_url = body.tracking_url ?? body.trackingUrl;
        const estimated_delivery_date = body.estimated_delivery_date ?? body.estimatedDeliveryDate;
        if (!orderId || !tracking_number) return jres({ error: 'orderId + tracking_number required' }, 400);
        const { data: shipment, error } = await svc.from('order_shipments').insert({
          order_id: orderId,
          carrier: carrier || null,
          tracking_number,
          tracking_url: tracking_url || null,
          estimated_delivery_date: estimated_delivery_date || null,
          status: 'label_created',
        }).select().single();
        if (error) return jres({ error: error.message }, 500);
        // Promote order status if not yet shipped/delivered.
        await svc.from('orders').update({ status: 'shipped' })
          .eq('id', orderId).in('status', ['placed','paid']);
        // Best-effort first refresh.
        try { await refreshShipment(svc, shipment.id); } catch { /* ignore */ }
        return jres({ shipment });
      }

      if (action === 'set-status') {
        const { orderId, status } = body;
        if (!orderId || !status) return jres({ error: 'orderId + status required' }, 400);
        const { error } = await svc.from('orders').update({ status }).eq('id', orderId);
        if (error) return jres({ error: error.message }, 500);
        return jres({ ok: true });
      }

      if (action === 'refresh-shipment') {
        const { shipmentId } = body;
        if (!shipmentId) return jres({ error: 'shipmentId required' }, 400);
        const result = await refreshShipment(svc, shipmentId);
        return jres(result);
      }

      // Default: create order. Accept both snake_case and camelCase.
      const customerId      = body.customerId      ?? body.customer_id;
      const callId          = body.callId          ?? body.call_id;
      const merchant_name   = body.merchantName    ?? body.merchant_name;
      const merchant_url    = body.merchantUrl     ?? body.merchant_url;
      const merchant_order_id = body.merchantOrderId ?? body.merchant_order_id;
      const item_summary    = body.itemSummary     ?? body.item_summary;
      const item_count      = body.itemCount       ?? body.item_count;
      const total_amount    = body.totalAmount     ?? body.total_amount;
      const currency        = body.currency;
      const status          = body.status;
      const internal_notes  = body.internalNotes   ?? body.internal_notes;
      const trackingNumber  = body.trackingNumber  ?? body.tracking_number;
      const carrier         = body.carrier;
      if (!customerId || !merchant_name) {
        return jres({ error: 'customerId, merchantName required' }, 400);
      }
      const { data: order, error } = await svc.from('orders').insert({
        customer_id: customerId,
        rep_id: rep.id,
        call_id: callId || null,
        merchant_name,
        merchant_url: merchant_url || null,
        merchant_order_id: merchant_order_id || null,
        item_summary: item_summary || null,
        item_count: item_count || null,
        total_amount: total_amount || null,
        currency: currency || 'USD',
        status: status || 'placed',
        internal_notes: internal_notes || null,
        ordered_at: new Date().toISOString(),
      }).select().single();
      if (error) return jres({ error: error.message }, 500);
      // If a tracking number was provided at creation time, attach it now.
      if (trackingNumber) {
        try {
          const { data: shipment } = await svc.from('order_shipments').insert({
            order_id: order.id,
            carrier: carrier || null,
            tracking_number: trackingNumber,
            status: 'label_created',
          }).select().single();
          await svc.from('orders').update({ status: 'shipped' })
            .eq('id', order.id).in('status', ['placed', 'paid']);
          if (shipment) { try { await refreshShipment(svc, shipment.id); } catch { /* ignore */ } }
        } catch { /* ignore */ }
      }
      return jres({ order });
    }

    return jres({ error: 'method not allowed' }, 405);
  } catch (err) {
    console.error('[orders]', err);
    return jres({ error: String((err as Error)?.message || err) }, 500);
  }
});

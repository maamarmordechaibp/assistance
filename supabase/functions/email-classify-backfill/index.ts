// Edge Function: email-classify-backfill
// Re-runs the merchant/carrier classifier across historical `customer_emails`
// rows and upserts any orders/shipments it finds. Useful after deploying a
// new classifier version, or for emails that landed before classification
// was wired up.
//
// POST body (all optional):
//   {
//     "limit": 200,           // max rows to process this run (default 100, max 500)
//     "since": "2026-04-01",  // ISO date — only emails received on/after
//     "onlyInbound": true,    // skip outbound (default true)
//     "runCarrierRefresh": false  // hit carrier APIs to enrich shipments (slow)
//   }
//
// Auth: admin-only (rep-app JWT with `app_metadata.role === 'admin'`).
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createServiceClient, getUser } from '../_shared/supabase.ts';
import { ingestEmailAsOrder } from '../_shared/order-ingest.ts';

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const user = await getUser(req);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  if (user.app_metadata?.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Admin only' }), {
      status: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const body = await req.json().catch(() => ({}));
  const limit = Math.min(Math.max(Number(body?.limit) || 100, 1), 500);
  const since = typeof body?.since === 'string' ? body.since : null;
  const onlyInbound = body?.onlyInbound !== false;
  const runCarrierRefresh = body?.runCarrierRefresh === true;

  const svc = createServiceClient();

  let q = svc
    .from('customer_emails')
    .select(
      'id, customer_id, from_address, subject, text_body, html_body, received_at, raw_payload, direction',
    )
    .order('received_at', { ascending: false })
    .limit(limit);
  if (onlyInbound) q = q.eq('direction', 'inbound');
  if (since) q = q.gte('received_at', since);

  const { data: rows, error } = await q;
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let scanned = 0;
  let matched = 0;
  let ordersCreated = 0;
  let shipmentsCreated = 0;
  const skipBuckets: Record<string, number> = {};

  for (const row of rows || []) {
    scanned++;
    try {
      const result = await ingestEmailAsOrder(
        svc,
        {
          id: row.id,
          customer_id: row.customer_id,
          from_address: row.from_address,
          subject: row.subject,
          text_body: row.text_body,
          html_body: row.html_body,
          received_at: row.received_at,
          raw_payload: row.raw_payload,
        },
        { runCarrierRefresh },
      );
      if (result.matched) {
        matched++;
        if (result.orderId) ordersCreated++;
        shipmentsCreated += result.shipmentIds?.length ?? 0;
      } else if (result.skipReason) {
        skipBuckets[result.skipReason] = (skipBuckets[result.skipReason] || 0) + 1;
      }
    } catch (err) {
      const reason = `error:${err instanceof Error ? err.message : String(err)}`.slice(0, 80);
      skipBuckets[reason] = (skipBuckets[reason] || 0) + 1;
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      scanned,
      matched,
      ordersCreated,
      shipmentsCreated,
      skipBuckets,
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
});

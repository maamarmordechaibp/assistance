// Edge Function: tracking-refresh-cron
//
// Refreshes carrier-tracking status for every active shipment whose
// `last_status_check_at` is older than the configured interval (default 6h).
//
// Hook this up to Supabase pg_cron or an external cron (Vercel Cron) calling:
//   POST /functions/v1/tracking-refresh-cron
//   Authorization: Bearer <SERVICE_ROLE>
//
// No auth = service-role only. Safe to call manually for testing.
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { refreshShipment } from '../_shared/tracking.ts';

const REFRESH_AFTER_MIN = 360;   // 6 hours
const MAX_PER_RUN       = 200;

function jres(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  // Service-role gate — only expected to be invoked by trusted cron.
  const auth = req.headers.get('authorization') || '';
  const expected = `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''}`;
  if (auth !== expected) return jres({ error: 'unauthorized' }, 401);

  const svc = createServiceClient();
  const cutoff = new Date(Date.now() - REFRESH_AFTER_MIN * 60_000).toISOString();

  const { data: due } = await svc.from('order_shipments')
    .select('id')
    .not('status', 'in', '(delivered,returned)')
    .or(`last_status_check_at.is.null,last_status_check_at.lt.${cutoff}`)
    .order('last_status_check_at', { ascending: true, nullsFirst: true })
    .limit(MAX_PER_RUN);

  let ok = 0, failed = 0;
  for (const row of (due || [])) {
    try {
      const r = await refreshShipment(svc, row.id);
      if (r.ok) ok++; else failed++;
    } catch { failed++; }
  }
  return jres({ scanned: (due || []).length, ok, failed });
});

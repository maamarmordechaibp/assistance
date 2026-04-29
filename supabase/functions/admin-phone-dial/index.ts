// Edge Function: admin-phone-dial
// ---------------------------------------------------------------
// Two endpoints:
//   POST  /admin-phone-dial          -- cron-driven; dequeues pending
//                                       admin_phone_alerts and places
//                                       outbound calls to admin numbers.
//                                       Auth: Bearer CRON_SECRET.
//   POST  /admin-phone-dial/voice    -- public TwiML/LaML endpoint that
//                                       SignalWire fetches when the call
//                                       is answered. Returns <Response>
//                                       with a <Say> announcement.
//
// Required secrets: CRON_SECRET, SIGNALWIRE_PROJECT_ID, SIGNALWIRE_API_TOKEN,
// SIGNALWIRE_SPACE_URL, SIGNALWIRE_FROM_NUMBER.
// ---------------------------------------------------------------
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { createCall } from '../_shared/signalwire.ts';

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function buildLaml(message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Pause length="1"/>\n  <Say voice="alice">${xmlEscape(message)}</Say>\n  <Pause length="1"/>\n  <Say voice="alice">${xmlEscape(message)}</Say>\n  <Hangup/>\n</Response>`;
}

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/admin-phone-dial/, '') || '/';

  const supabase = createServiceClient();

  // ── Public LaML voice endpoint ──
  if (path === '/voice' || path.endsWith('/voice')) {
    const alertId = url.searchParams.get('alert');
    let message = 'Critical alert from the assistance system.';
    if (alertId) {
      const { data } = await supabase
        .from('admin_phone_alerts')
        .select('reason, payload, rep_id, call_id')
        .eq('id', alertId)
        .maybeSingle();
      if (data) {
        const reason = (data.reason || 'critical_alert').replace(/_/g, ' ');
        const repId = data.rep_id;
        let repName = '';
        if (repId) {
          const { data: rep } = await supabase
            .from('reps')
            .select('full_name')
            .eq('id', repId)
            .maybeSingle();
          repName = rep?.full_name ? ` involving representative ${rep.full_name}` : '';
        }
        message = `Critical assistance alert. Reason: ${reason}${repName}. Please open the admin dashboard to review. Goodbye.`;
      }
    }
    return new Response(buildLaml(message), {
      headers: { ...corsHeaders, 'Content-Type': 'text/xml; charset=utf-8' },
    });
  }

  // ── Cron-driven dialer ──
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const cronSecret = Deno.env.get('CRON_SECRET');
  const auth = req.headers.get('authorization') || '';
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Settings: phone numbers + throttle
  const { data: settings } = await supabase
    .from('admin_settings')
    .select('key, value')
    .in('key', ['admin_phone_numbers', 'admin_phone_alert_throttle_seconds']);
  const settingsMap = Object.fromEntries((settings || []).map((s) => [s.key, s.value]));
  const phoneNumbers: string[] = Array.isArray(settingsMap.admin_phone_numbers)
    ? settingsMap.admin_phone_numbers as string[]
    : [];
  const throttleSeconds = Number(settingsMap.admin_phone_alert_throttle_seconds || 600);

  if (phoneNumbers.length === 0) {
    return new Response(JSON.stringify({ ok: true, dialed: 0, note: 'no admin phones configured' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const fromNumber = Deno.env.get('SIGNALWIRE_FROM_NUMBER');
  const projectRef = Deno.env.get('SUPABASE_URL')?.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];
  if (!fromNumber || !projectRef) {
    return new Response(JSON.stringify({ error: 'missing SIGNALWIRE_FROM_NUMBER or SUPABASE_URL' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const voiceBase = `https://${projectRef}.supabase.co/functions/v1/admin-phone-dial/voice`;

  // Throttle: skip alerts whose reason was dialed within window.
  const since = new Date(Date.now() - throttleSeconds * 1000).toISOString();
  const { data: pending } = await supabase
    .from('admin_phone_alerts')
    .select('id, reason, call_id, rep_id, payload')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(20);

  let dialed = 0;
  let skipped = 0;
  const results: Array<{ id: string; status: string; error?: string }> = [];

  for (const alert of pending || []) {
    // Throttle: was a similar alert dialed recently?
    const { count } = await supabase
      .from('admin_phone_alerts')
      .select('id', { count: 'exact', head: true })
      .eq('reason', alert.reason)
      .in('status', ['dialing', 'completed'])
      .gte('dialed_at', since);
    if ((count || 0) > 0) {
      await supabase.from('admin_phone_alerts')
        .update({ status: 'skipped', last_error: 'throttled' })
        .eq('id', alert.id);
      results.push({ id: alert.id, status: 'skipped' });
      skipped++;
      continue;
    }

    // Mark dialing.
    await supabase.from('admin_phone_alerts')
      .update({ status: 'dialing', dialed_at: new Date().toISOString(), attempts: 1 })
      .eq('id', alert.id);

    // Place a call to each admin number sequentially. First success wins;
    // we don't await all in parallel because we want to give the first
    // admin a chance to pick up before paging the next.
    let success = false;
    let lastErr = '';
    for (const num of phoneNumbers) {
      try {
        const r = await createCall({
          to: num,
          from: fromNumber,
          url: `${voiceBase}?alert=${alert.id}`,
          timeLimit: 60,
        });
        if (r?.sid) { success = true; break; }
        lastErr = JSON.stringify(r).slice(0, 200);
      } catch (e) {
        lastErr = (e as Error).message;
      }
    }

    await supabase.from('admin_phone_alerts')
      .update({
        status: success ? 'completed' : 'failed',
        completed_at: success ? new Date().toISOString() : null,
        last_error: success ? null : lastErr,
      })
      .eq('id', alert.id);

    results.push({ id: alert.id, status: success ? 'completed' : 'failed', error: success ? undefined : lastErr });
    if (success) dialed++;
  }

  return new Response(JSON.stringify({ ok: true, dialed, skipped, results }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});

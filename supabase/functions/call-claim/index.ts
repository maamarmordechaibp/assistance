// Edge Function: call-claim
// 1) Atomically claims a waiting call_queue row for the requesting rep.
// 2) REST-updates the caller's live call so SignalWire pulls fresh LaML
//    that does <Dial><Client>identity</Client></Dial> — delivering the INVITE
//    to the rep's already-connected SignalWire JS SDK websocket session.
//    (The browser does NOT client.dial() — "queue:<name>" is not a valid
//    Call Fabric address and silently opens a media session with no bridged
//    party.)
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createServiceClient, getUser } from '../_shared/supabase.ts';
import { updateCall, toSwIdentity } from '../_shared/signalwire.ts';

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const user = await getUser(req);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const body = await req.json().catch(() => ({}));
  const queueId = body?.queue_id;
  if (!queueId) {
    return new Response(JSON.stringify({ error: 'queue_id required' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const service = createServiceClient();

  // Atomic claim: only succeeds if still waiting AND (untargeted OR targeted at us).
  const { data, error } = await service
    .from('call_queue')
    .update({
      status: 'claimed',
      claimed_by_rep_id: user.id,
      claimed_at: new Date().toISOString(),
    })
    .eq('id', queueId)
    .eq('status', 'waiting')
    .or(`target_rep_id.is.null,target_rep_id.eq.${user.id}`)
    .select()
    .maybeSingle();

  if (error) {
    console.error('[call-claim] update error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  if (!data) {
    return new Response(JSON.stringify({ error: 'Already claimed or not found' }), {
      status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Look up this rep so the claim response can tell the UI how the bridge
  // is being delivered (PSTN cell vs SIP vs softphone). For PSTN/SIP there
  // is no browser INVITE, so the UI should hydrate its active-call panel
  // directly from the response instead of waiting for an invite.
  const { data: rep } = await service
    .from('reps')
    .select('id, email, phone_e164, sip_uri')
    .eq('id', user.id)
    .maybeSingle();

  const identity = rep?.email ? toSwIdentity(rep.email) : null;
  const bridgeMode: 'sip' | 'pstn' | 'browser' =
    rep?.sip_uri ? 'sip' : rep?.phone_e164 ? 'pstn' : 'browser';

  // Redirect the caller to our connect-claimed-rep LaML endpoint. It looks
  // up the rep's phone_e164 / sip_uri and <Dial>s them directly.
  let bridgeInitiated = false;
  try {
    if (data.call_sid) {
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const redirectUrl = `${supabaseUrl}/functions/v1/sw-inbound?step=connect-claimed-rep` +
        `&repId=${encodeURIComponent(user.id)}` +
        `&queueId=${encodeURIComponent(queueId)}`;
      const updateRes = await updateCall(data.call_sid, { url: redirectUrl, method: 'POST' });
      console.log('[call-claim] updateCall result:', JSON.stringify(updateRes).slice(0, 300));
      bridgeInitiated = true;
    } else {
      console.warn('[call-claim] skipping REST redirect — missing call_sid');
    }
  } catch (err) {
    console.error('[call-claim] updateCall failed:', err);
  }

  // Hydrate: pull the matching calls row (with AI brief) and recent customer
  // context so the rep UI can show everything the moment they pick up the
  // phone — no extra round trips.
  let callRow: Record<string, unknown> | null = null;
  let customer: Record<string, unknown> | null = null;
  let recentFindings: Array<Record<string, unknown>> = [];
  let credentialsCount = 0;

  if (data.call_sid) {
    const { data: c } = await service
      .from('calls')
      .select('id, call_sid, customer_id, inbound_phone, ai_intake_brief, ai_intake_completed, started_at, connected_at')
      .eq('call_sid', data.call_sid)
      .maybeSingle();
    callRow = (c as Record<string, unknown> | null) ?? null;
    // Mark connected_at so the rep-side timer starts immediately.
    if (callRow && !callRow.connected_at) {
      await service.from('calls')
        .update({ connected_at: new Date().toISOString(), rep_id: user.id })
        .eq('call_sid', data.call_sid);
      callRow.connected_at = new Date().toISOString();
      callRow.rep_id = user.id;
    }
  }

  if (data.customer_id) {
    const { data: cust } = await service
      .from('customers')
      .select('id, full_name, primary_phone, email, current_balance_minutes, total_minutes_purchased, preferred_language, notes')
      .eq('id', data.customer_id)
      .maybeSingle();
    customer = cust as Record<string, unknown> | null;

    const { data: findings } = await service
      .from('call_findings')
      .select('description, item_url, item_price, item_platform, item_notes, created_at')
      .eq('customer_id', data.customer_id)
      .order('created_at', { ascending: false })
      .limit(5);
    recentFindings = (findings ?? []) as Array<Record<string, unknown>>;

    const { count } = await service
      .from('customer_credentials')
      .select('id', { count: 'exact', head: true })
      .eq('customer_id', data.customer_id);
    credentialsCount = count ?? 0;
  }

  return new Response(JSON.stringify({
    queue_name: data.queue_name,
    call_sid: data.call_sid,
    from_number: data.from_number,
    customer_id: data.customer_id,
    identity,
    bridge_initiated: bridgeInitiated,
    bridge_mode: bridgeMode,
    call: callRow,
    customer,
    recent_findings: recentFindings,
    credentials_count: credentialsCount,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});

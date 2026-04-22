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

  // Look up this rep's SignalWire identity so the LaML redirect knows where
  // to deliver the INVITE.
  const { data: rep } = await service
    .from('reps')
    .select('id, email')
    .eq('id', user.id)
    .maybeSingle();

  const identity = rep?.email ? toSwIdentity(rep.email) : null;

  // Redirect the caller to our connect-claimed-rep LaML endpoint. This pulls
  // them out of the <Enqueue> waitroom and dials the rep's Call Fabric
  // subscriber identity, which routes the INVITE to the rep's SDK websocket.
  let bridgeInitiated = false;
  try {
    if (data.call_sid && identity) {
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const redirectUrl = `${supabaseUrl}/functions/v1/sw-inbound?step=connect-claimed-rep` +
        `&repId=${encodeURIComponent(user.id)}` +
        `&queueId=${encodeURIComponent(queueId)}` +
        `&identity=${encodeURIComponent(identity)}`;
      const updateRes = await updateCall(data.call_sid, { url: redirectUrl, method: 'POST' });
      console.log('[call-claim] updateCall result:', JSON.stringify(updateRes).slice(0, 300));
      bridgeInitiated = true;
    } else {
      console.warn('[call-claim] skipping REST redirect — missing call_sid or identity',
        { call_sid: data.call_sid, identity });
    }
  } catch (err) {
    console.error('[call-claim] updateCall failed:', err);
  }

  return new Response(JSON.stringify({
    queue_name: data.queue_name,
    call_sid: data.call_sid,
    from_number: data.from_number,
    customer_id: data.customer_id,
    identity,
    bridge_initiated: bridgeInitiated,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});

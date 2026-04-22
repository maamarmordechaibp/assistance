// Edge Function: call-claim
// Atomically claim a waiting call_queue row for the requesting rep.
// Browser then calls client.dial({ to: `queue:${queue_name}` }) which
// SignalWire bridges to the oldest caller enqueued under that name.
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createServiceClient, getUser } from '../_shared/supabase.ts';

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

  return new Response(JSON.stringify({
    queue_name: data.queue_name,
    call_sid: data.call_sid,
    from_number: data.from_number,
    customer_id: data.customer_id,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});

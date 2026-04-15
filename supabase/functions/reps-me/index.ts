// Edge Function: reps-me (GET rep info + WebRTC token, PATCH status)
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createUserClient, createServiceClient, getUser } from '../_shared/supabase.ts';
import { createWebRtcToken } from '../_shared/signalwire.ts';

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const user = await getUser(req);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  if (req.method === 'GET') {
    const service = createServiceClient();
    const { data: rep } = await service.from('reps').select('*').eq('id', user.id).single();

    if (!rep) {
      return new Response(JSON.stringify({ error: 'Rep not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    let webrtcToken = null;
    try {
      const tokenResult = await createWebRtcToken(rep.email);
      console.log('SignalWire token response:', JSON.stringify(tokenResult));
      webrtcToken = tokenResult?.jwt_token || tokenResult?.token || null;
    } catch (err) {
      console.error('SignalWire token error:', err);
    }

    const signalwireProjectId = Deno.env.get('SIGNALWIRE_PROJECT_ID') || null;
    return new Response(JSON.stringify({ rep, webrtcToken, signalwireProjectId }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  if (req.method === 'PATCH') {
    const body = await req.json();
    const { status } = body;

    if (!status || !['available', 'busy', 'offline', 'on_call'].includes(status)) {
      return new Response(JSON.stringify({ error: 'Invalid status' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const service = createServiceClient();
    const { data, error } = await service.from('reps').update({ status }).eq('id', user.id).select().single();
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(data), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});

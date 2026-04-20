// Diagnostic edge function for call flow debugging
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { createWebRtcToken, toSwIdentity } from '../_shared/signalwire.ts';

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const service = createServiceClient();
  const results: Record<string, unknown> = {};

  // 1. Test current user_role() value
  const { data: roleData, error: roleErr } = await service.rpc('user_role');
  results.user_role_via_service = roleData;
  results.user_role_error = roleErr?.message;

  // 2. Check reps and their statuses
  const { data: reps } = await service.from('reps').select('id, full_name, email, status');
  results.reps = reps?.map((r: { full_name: string; email: string; status: string }) => ({
    name: r.full_name,
    email: r.email,
    status: r.status,
    verto_identity: toSwIdentity(r.email),
  }));

  // 3. Check SignalWire config
  results.signalwire = {
    projectId: Deno.env.get('SIGNALWIRE_PROJECT_ID') || 'missing',
    apiToken: Deno.env.get('SIGNALWIRE_API_TOKEN') ? 'set' : 'missing',
    spaceUrl: Deno.env.get('SIGNALWIRE_SPACE_URL') || 'missing',
  };

  // 4. Test WebRTC token generation for first rep
  if (reps && reps.length > 0) {
    try {
      const rep = reps[0] as { email: string };
      const identity = toSwIdentity(rep.email);
      const tokenResult = await createWebRtcToken(rep.email);
      results.token_test = {
        for_email: rep.email,
        identity,
        response_keys: Object.keys(tokenResult || {}),
        has_jwt_token: !!tokenResult?.jwt_token,
        jwt_token_preview: tokenResult?.jwt_token ? (tokenResult.jwt_token as string).substring(0, 50) + '...' : null,
      };
    } catch (err) {
      results.token_test_error = String(err);
    }
  }

  // 5. Recent call traces (if table exists)
  const { data: traces, error: traceErr } = await service
    .from('call_traces')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20);
  if (traceErr) {
    results.call_traces_error = traceErr.message;
  } else {
    results.recent_call_traces = traces;
  }

  // 6. Check pending callbacks
  const { data: callbacks, error: cbErr } = await service
    .from('callback_requests')
    .select('id, phone_number, status, requested_at')
    .eq('status', 'pending')
    .limit(10);
  results.pending_callbacks = callbacks;
  if (cbErr) results.callbacks_error = cbErr.message;

  return new Response(JSON.stringify(results, null, 2), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});

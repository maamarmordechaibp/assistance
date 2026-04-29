// Edge Function: sms-send
// Sends an outbound SMS (or MMS with image) via SignalWire.
//   POST { to, message, mediaUrl? }
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createUserClient, getUser } from '../_shared/supabase.ts';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

function normalizeE164(num: string): string {
  let n = num.replace(/[^\d+]/g, '');
  if (!n.startsWith('+')) n = '+1' + n.replace(/^1/, '');
  return n;
}

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const user = await getUser(req);
  if (!user) return json({ error: 'unauthorized' }, 401);

  const userClient = createUserClient(req);
  const { data: rep } = await userClient.from('reps').select('id').eq('id', user.id).maybeSingle();
  if (!rep) {
    // Also allow admins
    const { data: admin } = await userClient.from('admins').select('id').eq('id', user.id).maybeSingle();
    if (!admin) return json({ error: 'reps and admins only' }, 403);
  }

  const body = await req.json().catch(() => null);
  if (!body) return json({ error: 'invalid json' }, 400);

  const { to, message, mediaUrl } = body as { to?: string; message?: string; mediaUrl?: string };

  if (!to || !message?.trim()) return json({ error: 'to and message are required' }, 400);

  const sid    = Deno.env.get('SIGNALWIRE_PROJECT_ID')  || Deno.env.get('SIGNALWIRE_PROJECT');
  const token  = Deno.env.get('SIGNALWIRE_API_TOKEN')   || Deno.env.get('SIGNALWIRE_TOKEN');
  const space  = Deno.env.get('SIGNALWIRE_SPACE')       || Deno.env.get('SIGNALWIRE_SPACE_URL');
  const fromNo = Deno.env.get('SIGNALWIRE_FROM_NUMBER');

  if (!sid || !token || !space || !fromNo) {
    return json({ error: 'SignalWire not configured on this server' }, 500);
  }

  const toE164 = normalizeE164(to);
  const auth   = btoa(`${sid}:${token}`);
  const host   = space.startsWith('http') ? space : `https://${space}`;

  const params = new URLSearchParams({ From: fromNo, To: toE164, Body: message.trim() });
  if (mediaUrl?.trim()) params.set('MediaUrl', mediaUrl.trim());

  const swRes = await fetch(`${host}/api/laml/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const swText = await swRes.text();
  if (!swRes.ok) {
    console.error('[sms-send] SignalWire error:', swRes.status, swText);
    return json({ error: 'SignalWire error', detail: swText }, 502);
  }

  const swJson = JSON.parse(swText);
  return json({ ok: true, messageSid: swJson.sid, to: toE164 });
});

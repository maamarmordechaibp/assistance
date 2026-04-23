// Edge Function: browser-session
// Manages persistent Browserbase sessions per customer.
//   POST   { customerId, callId? }   → start (or return) a live session, return live_url
//   DELETE ?customerId=…              → end the active session (cookies persisted to context)
//   GET    ?customerId=…              → return the active session if any + recent history
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createUserClient, createServiceClient, getUser } from '../_shared/supabase.ts';

const BB_API = 'https://api.browserbase.com/v1';

function bbHeaders() {
  return {
    'X-BB-API-Key': Deno.env.get('BROWSERBASE_API_KEY')!,
    'Content-Type': 'application/json',
  };
}

async function getOrCreateContext(svc: ReturnType<typeof createServiceClient>, customerId: string) {
  const projectId = Deno.env.get('BROWSERBASE_PROJECT_ID')!;
  const { data: existing } = await svc
    .from('customer_browser_contexts')
    .select('bb_context_id')
    .eq('customer_id', customerId)
    .maybeSingle();
  if (existing?.bb_context_id) return existing.bb_context_id;

  // Create a new persistent context for this customer
  const res = await fetch(`${BB_API}/contexts`, {
    method: 'POST',
    headers: bbHeaders(),
    body: JSON.stringify({ projectId }),
  });
  if (!res.ok) throw new Error(`Browserbase context create failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const contextId = json.id as string;
  await svc.from('customer_browser_contexts').insert({
    customer_id: customerId,
    bb_context_id: contextId,
  });
  return contextId;
}

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  const user = await getUser(req);
  if (!user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Confirm caller is a rep
  const userClient = createUserClient(req);
  const { data: rep } = await userClient.from('reps').select('id').eq('id', user.id).maybeSingle();
  if (!rep) {
    return new Response(JSON.stringify({ error: 'rep only' }), {
      status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const svc = createServiceClient();
  const url = new URL(req.url);
  const projectId = Deno.env.get('BROWSERBASE_PROJECT_ID')!;

  try {
    // ── GET: status + recent history ──────────────────────────
    if (req.method === 'GET') {
      const customerId = url.searchParams.get('customerId') || '';
      if (!customerId) return new Response(JSON.stringify({ error: 'customerId required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const { data: active } = await svc.from('customer_browser_sessions')
        .select('id, bb_session_id, live_url, started_at')
        .eq('customer_id', customerId).eq('status', 'active')
        .order('started_at', { ascending: false }).limit(1).maybeSingle();
      const { data: history } = await svc.from('customer_browser_history')
        .select('id, url, title, visited_at')
        .eq('customer_id', customerId).order('visited_at', { ascending: false }).limit(20);
      return new Response(JSON.stringify({ active, history: history || [] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── POST: start (or reuse) a session ──────────────────────
    if (req.method === 'POST') {
      const body = await req.json();
      const customerId: string = body.customerId;
      const callId: string | undefined = body.callId;
      if (!customerId) return new Response(JSON.stringify({ error: 'customerId required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

      // If an active session already exists, return it
      const { data: existing } = await svc.from('customer_browser_sessions')
        .select('id, bb_session_id, live_url, connect_url')
        .eq('customer_id', customerId).eq('status', 'active')
        .order('started_at', { ascending: false }).limit(1).maybeSingle();
      if (existing?.live_url) {
        return new Response(JSON.stringify({ session: existing }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Get or create the customer's persistent context
      const bbContextId = await getOrCreateContext(svc, customerId);

      // Start a fresh Browserbase session backed by that context (persist=true)
      const startRes = await fetch(`${BB_API}/sessions`, {
        method: 'POST', headers: bbHeaders(),
        body: JSON.stringify({
          projectId,
          browserSettings: {
            context: { id: bbContextId, persist: true },
          },
          keepAlive: false,
        }),
      });
      if (!startRes.ok) {
        return new Response(JSON.stringify({ error: 'browserbase start failed', detail: await startRes.text() }), {
          status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const startJson = await startRes.json();
      const bbSessionId: string = startJson.id;
      const connectUrl: string  = startJson.connectUrl;

      // Fetch the embeddable live debug URL
      let liveUrl = '';
      try {
        const liveRes = await fetch(`${BB_API}/sessions/${bbSessionId}/debug`, { headers: bbHeaders() });
        if (liveRes.ok) {
          const liveJson = await liveRes.json();
          liveUrl = liveJson.debuggerFullscreenUrl || liveJson.debuggerUrl || '';
        }
      } catch { /* ignore */ }

      const { data: insertedRows, error: insErr } = await svc.from('customer_browser_sessions').insert({
        customer_id: customerId,
        call_id: callId || null,
        rep_id: user.id,
        bb_session_id: bbSessionId,
        bb_context_id: bbContextId,
        connect_url: connectUrl,
        live_url: liveUrl,
        status: 'active',
      }).select('id, bb_session_id, live_url, connect_url').limit(1);
      if (insErr) throw insErr;

      // Stamp last_used_at on the context
      await svc.from('customer_browser_contexts')
        .update({ last_used_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('customer_id', customerId);

      return new Response(JSON.stringify({ session: insertedRows?.[0] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── DELETE: end the customer's active session ────────────
    if (req.method === 'DELETE') {
      const customerId = url.searchParams.get('customerId') || '';
      if (!customerId) return new Response(JSON.stringify({ error: 'customerId required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

      const { data: active } = await svc.from('customer_browser_sessions')
        .select('id, bb_session_id')
        .eq('customer_id', customerId).eq('status', 'active');
      for (const row of active || []) {
        try {
          // Tell Browserbase to stop the session — cookies persist to context
          await fetch(`${BB_API}/sessions/${row.bb_session_id}`, {
            method: 'POST', headers: bbHeaders(),
            body: JSON.stringify({ projectId, status: 'REQUEST_RELEASE' }),
          });
        } catch { /* still mark ended below */ }
        await svc.from('customer_browser_sessions')
          .update({ status: 'ended', ended_at: new Date().toISOString() })
          .eq('id', row.id);
      }
      return new Response(JSON.stringify({ ended: (active || []).length }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  } catch (err) {
    console.error('[browser-session]', err);
    return new Response(JSON.stringify({ error: String((err as Error)?.message || err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// Edge Function: rep-browser
// Personal per-rep Browserbase session (independent of customer calls).
// Uses a persistent bb context keyed to the rep so their logins/cookies survive.
//
//   POST   {}                               → start (or return) the rep's session
//   POST   { action:'new-tab', url? }        → open a new tab via CDP
//   POST   { action:'close-tab', targetId }  → close a tab
//   GET    ?                                 → return active session + most recent
//   GET    ?action=tabs                      → list tabs (pages) in the active session
//   DELETE                                   → end the rep's session
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createUserClient, createServiceClient, getUser } from '../_shared/supabase.ts';

const BB_API = 'https://api.browserbase.com/v1';
function bbHeaders() {
  return { 'X-BB-API-Key': Deno.env.get('BROWSERBASE_API_KEY')!, 'Content-Type': 'application/json' };
}

async function cdpBrowserCall(connectUrl: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const ws = new WebSocket(connectUrl);
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP connect timeout')), 12000);
      ws.onopen = () => { clearTimeout(t); resolve(); };
      ws.onerror = () => { clearTimeout(t); reject(new Error('CDP ws error')); };
    });
    const id = Math.floor(Math.random() * 1_000_000_000);
    const resultPromise = new Promise<unknown>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`${method} timeout`)), 12000);
      const listener = (e: MessageEvent) => {
        let msg: { id?: number; result?: unknown; error?: { message?: string } };
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.id === id) {
          clearTimeout(to);
          ws.removeEventListener('message', listener);
          if (msg.error) reject(new Error(msg.error.message || method));
          else resolve(msg.result);
        }
      };
      ws.addEventListener('message', listener);
    });
    ws.send(JSON.stringify({ id, method, params }));
    return await resultPromise;
  } finally {
    try { ws.close(); } catch { /* ignore */ }
  }
}

// Call a page-level CDP method using the flat-session protocol.
// 1. Connects to the browser-level WebSocket.
// 2. Attaches to the given target (page) to obtain a sessionId.
// 3. Sends the page command via that session and returns the result.
async function cdpPageCall(
  connectUrl: string,
  targetId: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 45000,
): Promise<unknown> {
  const ws = new WebSocket(connectUrl);
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP connect timeout')), 12000);
      ws.onopen = () => { clearTimeout(t); resolve(); };
      ws.onerror = () => { clearTimeout(t); reject(new Error('CDP ws error')); };
    });

    // Step 1: attach to target with flatten:true to get a sessionId
    const attachId = Math.floor(Math.random() * 1_000_000_000);
    const sessionId = await new Promise<string>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('Target.attachToTarget timeout')), 12000);
      const listener = (e: MessageEvent) => {
        let msg: { id?: number; result?: { sessionId?: string }; error?: { message?: string } };
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.id === attachId) {
          clearTimeout(to);
          ws.removeEventListener('message', listener);
          if (msg.error) reject(new Error(msg.error.message || 'attachToTarget failed'));
          else resolve(msg.result?.sessionId || '');
        }
      };
      ws.addEventListener('message', listener);
      ws.send(JSON.stringify({ id: attachId, method: 'Target.attachToTarget', params: { targetId, flatten: true } }));
    });

    // Step 2: send page-level command via sessionId
    const cmdId = Math.floor(Math.random() * 1_000_000_000);
    const result = await new Promise<unknown>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`${method} timeout`)), timeoutMs);
      const listener = (e: MessageEvent) => {
        let msg: { id?: number; sessionId?: string; result?: unknown; error?: { message?: string } };
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.id === cmdId && msg.sessionId === sessionId) {
          clearTimeout(to);
          ws.removeEventListener('message', listener);
          if (msg.error) reject(new Error(msg.error.message || method));
          else resolve(msg.result);
        }
      };
      ws.addEventListener('message', listener);
      ws.send(JSON.stringify({ id: cmdId, method, params, sessionId }));
    });

    return result;
  } finally {
    try { ws.close(); } catch { /* ignore */ }
  }
}

async function getOrCreateRepContext(svc: ReturnType<typeof createServiceClient>, repId: string): Promise<string> {
  const projectId = Deno.env.get('BROWSERBASE_PROJECT_ID')!;
  const { data: existing } = await svc.from('rep_browser_contexts')
    .select('bb_context_id').eq('rep_id', repId).maybeSingle();
  if (existing?.bb_context_id) return existing.bb_context_id;

  const res = await fetch(`${BB_API}/contexts`, { method: 'POST', headers: bbHeaders(), body: JSON.stringify({ projectId }) });
  if (!res.ok) throw new Error(`Browserbase context create failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const contextId = json.id as string;
  await svc.from('rep_browser_contexts').insert({ rep_id: repId, bb_context_id: contextId });
  return contextId;
}

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  const user = await getUser(req);
  if (!user) return json({ error: 'unauthorized' }, 401);
  const userClient = createUserClient(req);
  const { data: rep } = await userClient.from('reps').select('id').eq('id', user.id).maybeSingle();
  if (!rep) return json({ error: 'rep only' }, 403);

  const svc = createServiceClient();
  const url = new URL(req.url);
  const projectId = Deno.env.get('BROWSERBASE_PROJECT_ID')!;

  // Fast-fail with a clear error if the migration wasn't run yet.
  {
    const { error: tblErr } = await svc.from('rep_browser_sessions').select('id').limit(1);
    if (tblErr && /relation .* does not exist|not find the table/i.test(tblErr.message || '')) {
      return json({ error: 'migration_missing', detail: 'Run supabase/migrations/20260423_rep_browser.sql in the SQL editor.' }, 503);
    }
  }

  try {
    if (req.method === 'GET') {
      const action = url.searchParams.get('action') || '';
      const { data: active } = await svc.from('rep_browser_sessions')
        .select('id, bb_session_id, live_url, connect_url, started_at')
        .eq('rep_id', user.id).eq('status', 'active')
        .order('started_at', { ascending: false }).limit(1).maybeSingle();

      if (action === 'tabs') {
        if (!active?.bb_session_id) return json({ pages: [] });
        const r = await fetch(`${BB_API}/sessions/${active.bb_session_id}/debug`, { headers: bbHeaders() });
        if (!r.ok) return json({ error: 'debug fetch failed', detail: await r.text() }, 502);
        const j = await r.json();
        const pages = (j.pages || []).map((p: Record<string, unknown>) => ({
          id: p.id, url: p.url, title: p.title, faviconUrl: p.faviconUrl,
          debuggerFullscreenUrl: p.debuggerFullscreenUrl || p.debuggerUrl,
        }));
        return json({ sessionId: active.bb_session_id, pages });
      }
      return json({ active });
    }

    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const action: string = body.action || '';

      if (action === 'new-tab' || action === 'close-tab') {
        const { data: active } = await svc.from('rep_browser_sessions')
          .select('connect_url').eq('rep_id', user.id).eq('status', 'active')
          .order('started_at', { ascending: false }).limit(1).maybeSingle();
        if (!active?.connect_url) return json({ error: 'no active session' }, 400);
        try {
          if (action === 'new-tab') {
            const tabUrl: string = body.url || 'about:blank';
            const result = await cdpBrowserCall(active.connect_url, 'Target.createTarget', { url: tabUrl });
            return json({ ok: true, targetId: (result as { targetId?: string }).targetId });
          } else {
            const targetId: string = body.targetId;
            if (!targetId) return json({ error: 'targetId required' }, 400);
            await cdpBrowserCall(active.connect_url, 'Target.closeTarget', { targetId });
            return json({ ok: true });
          }
        } catch (err) {
          return json({ error: 'cdp call failed', detail: String((err as Error).message) }, 502);
        }
      }

      if (action === 'print-pdf') {
        const targetId: string = body.targetId;
        if (!targetId) return json({ error: 'targetId required' }, 400);
        const { data: active } = await svc.from('rep_browser_sessions')
          .select('connect_url').eq('rep_id', user.id).eq('status', 'active')
          .order('started_at', { ascending: false }).limit(1).maybeSingle();
        if (!active?.connect_url) return json({ error: 'no active session' }, 400);
        try {
          const result = await cdpPageCall(active.connect_url, targetId, 'Page.printToPDF', {
            printBackground: true,
            paperWidth: 8.5,
            paperHeight: 11,
            marginTop: 0.4,
            marginBottom: 0.4,
            marginLeft: 0.4,
            marginRight: 0.4,
          });
          return json({ pdf: (result as { data?: string }).data });
        } catch (err) {
          return json({ error: 'pdf failed', detail: String((err as Error).message) }, 502);
        }
      }

      // Default: start (or reuse) session
      const { data: existing } = await svc.from('rep_browser_sessions')
        .select('id, bb_session_id, live_url, connect_url')
        .eq('rep_id', user.id).eq('status', 'active')
        .order('started_at', { ascending: false }).limit(1).maybeSingle();
      if (existing?.live_url) return json({ session: existing });

      const bbContextId = await getOrCreateRepContext(svc, user.id);
      const startRes = await fetch(`${BB_API}/sessions`, {
        method: 'POST', headers: bbHeaders(),
        body: JSON.stringify({
          projectId,
          browserSettings: {
            context: { id: bbContextId, persist: true },
            viewport: { width: 1920, height: 1080 },
            blockAds: true,
          },
          keepAlive: false,
        }),
      });
      if (!startRes.ok) return json({ error: 'browserbase start failed', detail: await startRes.text() }, 502);
      const startJson = await startRes.json();
      const bbSessionId: string = startJson.id;
      const connectUrl: string = startJson.connectUrl;

      let liveUrl = '';
      try {
        const r = await fetch(`${BB_API}/sessions/${bbSessionId}/debug`, { headers: bbHeaders() });
        if (r.ok) {
          const j = await r.json();
          liveUrl = j.debuggerFullscreenUrl || j.debuggerUrl || '';
        }
      } catch { /* ignore */ }

      const { data: inserted, error: insErr } = await svc.from('rep_browser_sessions').insert({
        rep_id: user.id,
        bb_session_id: bbSessionId,
        bb_context_id: bbContextId,
        connect_url: connectUrl,
        live_url: liveUrl,
        status: 'active',
      }).select('id, bb_session_id, live_url, connect_url').single();
      if (insErr) throw insErr;

      await svc.from('rep_browser_contexts')
        .update({ last_used_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('rep_id', user.id);

      return json({ session: inserted });
    }

    if (req.method === 'DELETE') {
      const { data: active } = await svc.from('rep_browser_sessions')
        .select('id, bb_session_id').eq('rep_id', user.id).eq('status', 'active');
      for (const row of active || []) {
        try {
          await fetch(`${BB_API}/sessions/${row.bb_session_id}`, {
            method: 'POST', headers: bbHeaders(),
            body: JSON.stringify({ projectId, status: 'REQUEST_RELEASE' }),
          });
        } catch { /* ignore */ }
        await svc.from('rep_browser_sessions')
          .update({ status: 'ended', ended_at: new Date().toISOString() })
          .eq('id', row.id);
      }
      return json({ ended: (active || []).length });
    }

    return json({ error: 'method not allowed' }, 405);
  } catch (err) {
    console.error('[rep-browser]', err);
    return json({ error: String((err as Error)?.message || err) }, 500);
  }
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

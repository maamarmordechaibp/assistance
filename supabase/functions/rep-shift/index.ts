// Edge Function: rep-shift
// Manages rep work sessions (clock in/out) + heartbeat for inactivity detection.
//
// POST /start      -> opens a session for the rep (idempotent — returns
//                     existing open session if one exists). Sets rep
//                     status to 'available'.
// POST /end        -> closes the rep's open session, sets status 'offline'.
//                     body: { reason?: 'manual' | 'idle_timeout' | 'admin_force' }
// POST /heartbeat  -> bumps last_heartbeat_at on the open session.
//
// Path is taken from the URL pathname suffix.
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createServiceClient, getUser } from '../_shared/supabase.ts';

type EndReason = 'manual' | 'idle_timeout' | 'admin_force' | 'crash';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function recordStatusEvent(
  service: ReturnType<typeof createServiceClient>,
  repId: string,
  fromStatus: string | null,
  toStatus: string,
  reason: string,
  sessionId?: string | null,
  callId?: string | null,
) {
  await service.from('rep_status_events').insert({
    rep_id: repId,
    from_status: fromStatus,
    to_status: toStatus,
    reason,
    session_id: sessionId ?? null,
    call_id: callId ?? null,
  });
}

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const user = await getUser(req);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const url = new URL(req.url);
  const action = url.pathname.split('/').pop() ?? '';

  const service = createServiceClient();

  // --- START ---
  if (action === 'start') {
    // Look for an existing open session
    const { data: existing } = await service
      .from('rep_sessions')
      .select('*')
      .eq('rep_id', user.id)
      .is('ended_at', null)
      .maybeSingle();

    if (existing) {
      // Refresh heartbeat
      await service
        .from('rep_sessions')
        .update({ last_heartbeat_at: new Date().toISOString() })
        .eq('id', existing.id);
      return json({ session: existing, resumed: true });
    }

    const { data: rep } = await service
      .from('reps')
      .select('status')
      .eq('id', user.id)
      .maybeSingle();

    const { data: session, error } = await service
      .from('rep_sessions')
      .insert({ rep_id: user.id })
      .select()
      .single();
    if (error) return json({ error: error.message }, 500);

    // Flip rep to available
    const { data: updated } = await service
      .from('reps')
      .update({ status: 'available' })
      .eq('id', user.id)
      .select('status')
      .single();

    await recordStatusEvent(
      service,
      user.id,
      rep?.status ?? null,
      updated?.status ?? 'available',
      'shift_start',
      session.id,
    );

    return json({ session, resumed: false });
  }

  // --- HEARTBEAT ---
  if (action === 'heartbeat') {
    const now = new Date().toISOString();
    const { data, error } = await service
      .from('rep_sessions')
      .update({ last_heartbeat_at: now })
      .eq('rep_id', user.id)
      .is('ended_at', null)
      .select('id, last_heartbeat_at')
      .maybeSingle();
    if (error) return json({ error: error.message }, 500);
    if (!data) return json({ error: 'No open session' }, 404);
    return json({ ok: true, last_heartbeat_at: data.last_heartbeat_at });
  }

  // --- END ---
  if (action === 'end') {
    const body = await req.json().catch(() => ({}));
    const reason: EndReason =
      ['manual', 'idle_timeout', 'admin_force', 'crash'].includes(body?.reason)
        ? body.reason
        : 'manual';

    const { data: open } = await service
      .from('rep_sessions')
      .select('*')
      .eq('rep_id', user.id)
      .is('ended_at', null)
      .maybeSingle();

    if (!open) return json({ ok: true, already_closed: true });

    const startedAt = new Date(open.started_at).getTime();
    const endedAt = Date.now();
    const totalActive = Math.max(0, Math.round((endedAt - startedAt) / 1000));

    // Sum call seconds in this shift window
    const { data: callRows } = await service
      .from('calls')
      .select('total_duration_seconds, billable_duration_seconds, started_at')
      .eq('rep_id', user.id)
      .gte('started_at', open.started_at)
      .lte('started_at', new Date(endedAt).toISOString());
    const totalCall = (callRows ?? []).reduce(
      (sum, r: { total_duration_seconds?: number | null }) =>
        sum + (r.total_duration_seconds ?? 0),
      0,
    );

    const { data: rep } = await service
      .from('reps')
      .select('status')
      .eq('id', user.id)
      .maybeSingle();

    const { error: closeErr } = await service
      .from('rep_sessions')
      .update({
        ended_at: new Date(endedAt).toISOString(),
        end_reason: reason,
        total_active_seconds: totalActive,
        total_call_seconds: totalCall,
      })
      .eq('id', open.id);
    if (closeErr) return json({ error: closeErr.message }, 500);

    await service.from('reps').update({ status: 'offline' }).eq('id', user.id);

    await recordStatusEvent(
      service,
      user.id,
      rep?.status ?? null,
      'offline',
      'shift_end',
      open.id,
    );

    return json({
      ok: true,
      session_id: open.id,
      total_active_seconds: totalActive,
      total_call_seconds: totalCall,
      end_reason: reason,
    });
  }

  return json({ error: 'Unknown action' }, 400);
});

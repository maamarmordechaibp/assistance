// Edge Function: rep-monitor
// Cron-driven sweep that does three things:
//   1. Idle timeout — closes rep_sessions whose last_heartbeat_at is older
//      than admin_settings.rep_idle_timeout_seconds and emits rep_idle alert.
//   2. Missed calls — when a call_queue row has been 'waiting' longer than
//      admin_settings.missed_call_threshold_seconds while at least one rep
//      is 'available', logs a missed_calls row + admin alert.
//   3. Wrap-up auto-submit — for any rep stuck in 'wrap_up' for more than
//      admin_settings.wrap_up_grace_seconds, inserts a blank
//      call_outcomes row (auto_submitted=true) and resets status.
//
// Auth: requires `Authorization: Bearer <CRON_SECRET>` header (set the
// CRON_SECRET env var on the function and on the pg_cron job).
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase.ts';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

interface SettingsMap {
  rep_idle_timeout_seconds: number;
  missed_call_threshold_seconds: number;
  wrap_up_grace_seconds: number;
  admin_alert_email_throttle_seconds: number;
}

const DEFAULTS: SettingsMap = {
  rep_idle_timeout_seconds: 600,
  missed_call_threshold_seconds: 30,
  wrap_up_grace_seconds: 60,
  admin_alert_email_throttle_seconds: 300,
};

async function loadSettings(
  service: ReturnType<typeof createServiceClient>,
): Promise<SettingsMap> {
  const { data } = await service
    .from('admin_settings')
    .select('key, value')
    .in('key', Object.keys(DEFAULTS));
  const out = { ...DEFAULTS };
  for (const row of data ?? []) {
    const k = row.key as keyof SettingsMap;
    const v = typeof row.value === 'number' ? row.value : Number(row.value);
    if (!Number.isNaN(v)) out[k] = v;
  }
  return out;
}

async function emailAdminsIfNotThrottled(
  service: ReturnType<typeof createServiceClient>,
  alertId: string,
  kind: string,
  subject: string,
  body: string,
  throttleSeconds: number,
) {
  const since = new Date(Date.now() - throttleSeconds * 1000).toISOString();
  const { data: recent } = await service
    .from('admin_alerts')
    .select('id')
    .eq('kind', kind)
    .not('email_sent_at', 'is', null)
    .gte('email_sent_at', since)
    .limit(1);
  if (recent && recent.length > 0) return;

  // Pull admin emails from auth.users via reps + role check
  const { data: admins } = await service
    .from('reps')
    .select('email, id, full_name');
  // Filter to admin role via user metadata — call admin_users RPC if available,
  // fall back to admin_alert_emails setting.
  const { data: setting } = await service
    .from('admin_settings')
    .select('value')
    .eq('key', 'admin_alert_emails')
    .maybeSingle();

  let recipients: string[] = [];
  if (Array.isArray(setting?.value)) {
    recipients = (setting.value as unknown[]).map(String).filter(Boolean);
  }
  if (recipients.length === 0) {
    // Best-effort: pull users with admin role via auth.admin.listUsers
    try {
      const { data: list } = await service.auth.admin.listUsers({ perPage: 200 });
      recipients = (list?.users ?? [])
        .filter((u) => (u.app_metadata as { role?: string })?.role === 'admin')
        .map((u) => u.email)
        .filter((e): e is string => !!e);
    } catch (_) { /* ignore */ }
  }
  if (recipients.length === 0) return;

  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!resendKey) return;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Offline Admin <admin@offlinesbrowse.com>',
        to: recipients,
        subject,
        text: body,
      }),
    });
    if (r.ok) {
      await service
        .from('admin_alerts')
        .update({ email_sent_at: new Date().toISOString() })
        .eq('id', alertId);
    }
  } catch (err) {
    console.error('[rep-monitor] email send failed:', err);
  }
}

async function sweepIdle(
  service: ReturnType<typeof createServiceClient>,
  s: SettingsMap,
) {
  const cutoff = new Date(Date.now() - s.rep_idle_timeout_seconds * 1000).toISOString();
  const { data: stale } = await service
    .from('rep_sessions')
    .select('*')
    .is('ended_at', null)
    .lt('last_heartbeat_at', cutoff);

  for (const session of stale ?? []) {
    const startedAt = new Date(session.started_at).getTime();
    const endedAt = new Date(session.last_heartbeat_at).getTime();
    const totalActive = Math.max(0, Math.round((endedAt - startedAt) / 1000));

    const { data: callRows } = await service
      .from('calls')
      .select('total_duration_seconds')
      .eq('rep_id', session.rep_id)
      .gte('started_at', session.started_at)
      .lte('started_at', session.last_heartbeat_at);
    const totalCall = (callRows ?? []).reduce(
      (sum, r: { total_duration_seconds?: number | null }) =>
        sum + (r.total_duration_seconds ?? 0),
      0,
    );

    await service
      .from('rep_sessions')
      .update({
        ended_at: new Date(endedAt).toISOString(),
        end_reason: 'idle_timeout',
        total_active_seconds: totalActive,
        total_call_seconds: totalCall,
      })
      .eq('id', session.id);

    const { data: rep } = await service
      .from('reps')
      .select('status, full_name, email')
      .eq('id', session.rep_id)
      .maybeSingle();

    await service.from('reps').update({ status: 'offline' }).eq('id', session.rep_id);
    await service.from('rep_status_events').insert({
      rep_id: session.rep_id,
      from_status: rep?.status ?? null,
      to_status: 'offline',
      reason: 'idle_logout',
      session_id: session.id,
    });

    const { data: alert } = await service
      .from('admin_alerts')
      .insert({
        kind: 'rep_idle',
        severity: 'warning',
        payload: {
          rep_id: session.rep_id,
          rep_name: rep?.full_name ?? null,
          rep_email: rep?.email ?? null,
          session_id: session.id,
          total_active_seconds: totalActive,
        },
      })
      .select('id')
      .single();

    if (alert) {
      await emailAdminsIfNotThrottled(
        service,
        alert.id,
        'rep_idle',
        `Rep auto-logged-out (idle): ${rep?.full_name ?? 'Unknown'}`,
        `Rep ${rep?.full_name ?? '(unknown)'} <${rep?.email ?? ''}> was auto-logged-out after exceeding the idle timeout.\nSession active: ${totalActive}s.`,
        s.admin_alert_email_throttle_seconds,
      );
    }
  }

  return stale?.length ?? 0;
}

async function sweepMissedCalls(
  service: ReturnType<typeof createServiceClient>,
  s: SettingsMap,
) {
  // Are there any reps currently 'available'?
  const { count: availableReps } = await service
    .from('reps')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'available');
  if (!availableReps) return 0;

  const cutoff = new Date(Date.now() - s.missed_call_threshold_seconds * 1000).toISOString();
  const { data: ringing } = await service
    .from('call_queue')
    .select('id, target_rep_id, customer_id, enqueued_at, from_number')
    .eq('status', 'waiting')
    .lt('enqueued_at', cutoff);

  let inserted = 0;
  for (const q of ringing ?? []) {
    const rangSeconds = Math.round(
      (Date.now() - new Date(q.enqueued_at).getTime()) / 1000,
    );

    // ON CONFLICT DO NOTHING via uq_missed_calls_queue unique index
    const { error: insErr } = await service.from('missed_calls').insert({
      call_queue_id: q.id,
      rep_id: q.target_rep_id,
      customer_id: q.customer_id,
      rang_seconds: rangSeconds,
    });
    // Duplicate (already missed-logged) — skip
    if (insErr && !String(insErr.message).includes('duplicate')) {
      console.error('[rep-monitor] missed insert err:', insErr);
      continue;
    }
    if (insErr) continue;

    inserted += 1;
    const { data: alert } = await service
      .from('admin_alerts')
      .insert({
        kind: 'missed_call',
        severity: 'warning',
        payload: {
          call_queue_id: q.id,
          target_rep_id: q.target_rep_id,
          customer_id: q.customer_id,
          from_number: q.from_number,
          rang_seconds: rangSeconds,
        },
      })
      .select('id')
      .single();

    if (alert) {
      await emailAdminsIfNotThrottled(
        service,
        alert.id,
        'missed_call',
        `Missed call alert (${rangSeconds}s ringing)`,
        `An incoming call from ${q.from_number ?? 'unknown'} has been ringing for ${rangSeconds}s with available rep(s) online.`,
        s.admin_alert_email_throttle_seconds,
      );
    }
  }
  return inserted;
}

async function sweepWrapUp(
  service: ReturnType<typeof createServiceClient>,
  s: SettingsMap,
) {
  const cutoff = new Date(Date.now() - s.wrap_up_grace_seconds * 1000).toISOString();
  // Find reps in wrap_up whose latest status event was before the cutoff.
  const { data: wrapReps } = await service
    .from('reps')
    .select('id')
    .eq('status', 'wrap_up');

  let processed = 0;
  for (const rep of wrapReps ?? []) {
    const { data: latest } = await service
      .from('rep_status_events')
      .select('created_at, call_id')
      .eq('rep_id', rep.id)
      .eq('to_status', 'wrap_up')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!latest || latest.created_at >= cutoff) continue;
    const callId = latest.call_id;

    if (callId) {
      const { data: existing } = await service
        .from('call_outcomes')
        .select('call_id')
        .eq('call_id', callId)
        .maybeSingle();

      if (!existing) {
        await service.from('call_outcomes').insert({
          call_id: callId,
          rep_id: rep.id,
          auto_submitted: true,
        });
      }
    }

    await service.from('reps').update({ status: 'available' }).eq('id', rep.id);
    await service.from('rep_status_events').insert({
      rep_id: rep.id,
      from_status: 'wrap_up',
      to_status: 'available',
      reason: 'wrap_up_timeout',
      call_id: callId,
    });
    processed += 1;
  }
  return processed;
}

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  // Auth: shared secret
  const cronSecret = Deno.env.get('CRON_SECRET');
  const auth = req.headers.get('Authorization') ?? '';
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const service = createServiceClient();
  const settings = await loadSettings(service);

  const [idleClosed, missedLogged, wrapResolved] = await Promise.all([
    sweepIdle(service, settings).catch((e) => {
      console.error('[rep-monitor] sweepIdle error', e);
      return 0;
    }),
    sweepMissedCalls(service, settings).catch((e) => {
      console.error('[rep-monitor] sweepMissed error', e);
      return 0;
    }),
    sweepWrapUp(service, settings).catch((e) => {
      console.error('[rep-monitor] sweepWrap error', e);
      return 0;
    }),
  ]);

  return json({ ok: true, idle_closed: idleClosed, missed_logged: missedLogged, wrap_resolved: wrapResolved });
});

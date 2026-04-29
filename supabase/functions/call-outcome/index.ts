// Edge Function: call-outcome
// Rep submits the post-call questionnaire. Inserts/updates the call_outcomes
// row, logs a rep_status_events row, and flips the rep's status from
// 'wrap_up' back to 'available'. The rep-monitor cron will auto-submit a
// blank outcome if the rep doesn't submit within the wrap_up_grace_seconds.
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createServiceClient, getUser } from '../_shared/supabase.ts';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

interface OutcomeBody {
  call_id: string;
  resolved?: 'yes' | 'no' | 'partial' | null;
  task_category_id?: string | null;
  order_placed?: boolean;
  order_id?: string | null;
  payment_taken?: boolean;
  payment_amount_cents?: number | null;
  callback_needed?: boolean;
  callback_at?: string | null;
  notes?: string | null;
  auto_submitted?: boolean;
}

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const user = await getUser(req);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const body = (await req.json().catch(() => ({}))) as OutcomeBody;
  if (!body?.call_id) return json({ error: 'call_id required' }, 400);

  // Validate enums
  if (body.resolved && !['yes', 'no', 'partial'].includes(body.resolved)) {
    return json({ error: 'invalid resolved value' }, 400);
  }

  const service = createServiceClient();

  // Confirm the rep owns this call (or is admin role — but this endpoint is
  // rep-facing).
  const { data: call, error: callErr } = await service
    .from('calls')
    .select('id, rep_id')
    .eq('id', body.call_id)
    .maybeSingle();
  if (callErr) return json({ error: callErr.message }, 500);
  if (!call) return json({ error: 'Call not found' }, 404);
  if (call.rep_id && call.rep_id !== user.id) {
    return json({ error: 'Call belongs to another rep' }, 403);
  }

  const upsertPayload = {
    call_id: body.call_id,
    rep_id: user.id,
    resolved: body.resolved ?? null,
    task_category_id: body.task_category_id ?? null,
    order_placed: !!body.order_placed,
    order_id: body.order_id ?? null,
    payment_taken: !!body.payment_taken,
    payment_amount_cents:
      typeof body.payment_amount_cents === 'number' ? body.payment_amount_cents : null,
    callback_needed: !!body.callback_needed,
    callback_at: body.callback_at ?? null,
    notes: body.notes ?? null,
    submitted_at: new Date().toISOString(),
    auto_submitted: !!body.auto_submitted,
  };

  const { error: upsertErr } = await service
    .from('call_outcomes')
    .upsert(upsertPayload, { onConflict: 'call_id' });
  if (upsertErr) return json({ error: upsertErr.message }, 500);

  // Mirror task_category onto calls row for legacy queries.
  if (body.task_category_id) {
    await service
      .from('calls')
      .update({ task_category_id: body.task_category_id })
      .eq('id', body.call_id);
  }

  // Reset rep status if currently in wrap_up.
  const { data: rep } = await service
    .from('reps')
    .select('status')
    .eq('id', user.id)
    .maybeSingle();

  if (rep?.status === 'wrap_up') {
    await service.from('reps').update({ status: 'available' }).eq('id', user.id);
    await service.from('rep_status_events').insert({
      rep_id: user.id,
      from_status: 'wrap_up',
      to_status: 'available',
      reason: 'outcome_submitted',
      call_id: body.call_id,
    });
  }

  return json({ ok: true });
});

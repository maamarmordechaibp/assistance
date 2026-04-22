// Edge Function: call-outbound
// Tracks rep-initiated outbound calls placed via the browser softphone.
//  POST with { action: 'start', to_number, customer_id? }
//    → inserts a calls row, returns { call_id, customer_id, customer_name, balance_minutes }
//  POST with { action: 'end', call_id, duration_seconds }
//    → stamps ended_at, total_duration_seconds, minutes_deducted, inserts
//      minute_ledger row, decrements customers.current_balance_minutes.
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createServiceClient, getUser } from '../_shared/supabase.ts';

function normalizePhone(p: string): string {
  const digits = p.replace(/[^0-9+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits;
}

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
  const action = body?.action;
  const supabase = createServiceClient();

  // ── START: create calls row ──
  if (action === 'start') {
    const rawTo = String(body?.to_number || '').trim();
    if (!rawTo) {
      return new Response(JSON.stringify({ error: 'to_number required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const toNumber = normalizePhone(rawTo);

    // Resolve customer: use provided id, else look up by phone
    let customerId: string | null = body?.customer_id ?? null;
    let customer: { id: string; full_name: string; current_balance_minutes: number } | null = null;

    if (customerId) {
      const { data } = await supabase
        .from('customers')
        .select('id, full_name, current_balance_minutes')
        .eq('id', customerId)
        .maybeSingle();
      customer = data ?? null;
    } else {
      const { data } = await supabase
        .from('customers')
        .select('id, full_name, current_balance_minutes')
        .eq('primary_phone', toNumber)
        .maybeSingle();
      customer = data ?? null;
      customerId = customer?.id ?? null;
    }

    // Rep row tied to the calling user (auth.users.id == reps.id by convention,
    // fall back to email match for admins who are also reps).
    let { data: rep } = await supabase
      .from('reps')
      .select('id')
      .eq('id', user.id)
      .maybeSingle();
    if (!rep) {
      const { data: repByEmail } = await supabase
        .from('reps')
        .select('id')
        .eq('email', user.email)
        .maybeSingle();
      rep = repByEmail ?? null;
    }

    const clientCallId = String(body?.client_call_id || crypto.randomUUID());
    const { data: inserted, error } = await supabase
      .from('calls')
      .insert({
        customer_id: customerId,
        rep_id: rep?.id ?? null,
        inbound_phone: toNumber,
        call_sid: `browser-out-${clientCallId}`,
        started_at: new Date().toISOString(),
        connected_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (error) {
      console.error('[call-outbound] insert error:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      call_id: inserted.id,
      customer_id: customerId,
      customer_name: customer?.full_name ?? null,
      balance_minutes: customer?.current_balance_minutes ?? null,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  // ── END: finalize call + deduct minutes ──
  if (action === 'end') {
    const callId = body?.call_id;
    const durationSecs = Math.max(0, Number(body?.duration_seconds || 0));
    if (!callId) {
      return new Response(JSON.stringify({ error: 'call_id required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const minutes = Math.ceil(durationSecs / 60);

    const { data: call, error: callErr } = await supabase
      .from('calls')
      .update({
        ended_at: new Date().toISOString(),
        total_duration_seconds: durationSecs,
        billable_duration_seconds: durationSecs,
        minutes_deducted: minutes,
      })
      .eq('id', callId)
      .select('id, customer_id, rep_id')
      .single();

    if (callErr) {
      console.error('[call-outbound] end update error:', callErr);
      return new Response(JSON.stringify({ error: callErr.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Deduct minutes from customer (if known and duration > 0)
    if (call?.customer_id && minutes > 0) {
      await supabase.from('minute_ledger').insert({
        customer_id: call.customer_id,
        entry_type: 'deduction',
        minutes_amount: -minutes,
        reason: 'Outbound call',
        performed_by: user.id,
        call_id: call.id,
      });
      const { data: customer } = await supabase
        .from('customers')
        .select('current_balance_minutes, total_minutes_used')
        .eq('id', call.customer_id)
        .single();
      if (customer) {
        await supabase
          .from('customers')
          .update({
            current_balance_minutes: Number(customer.current_balance_minutes || 0) - minutes,
            total_minutes_used: Number(customer.total_minutes_used || 0) + minutes,
          })
          .eq('id', call.customer_id);
      }
    }

    return new Response(JSON.stringify({ success: true, minutes_deducted: minutes }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ error: 'Unknown action' }), {
    status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});

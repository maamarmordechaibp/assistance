// Edge Function: sw-status (call completion, billing, AI trigger)
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { calculateBillableMinutes } from '../_shared/utils.ts';

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const formData = await req.formData();
  const callSid = formData.get('CallSid') as string;
  const callStatus = formData.get('CallStatus') as string;
  const callDuration = formData.get('CallDuration') as string;
  const recordingUrl = formData.get('RecordingUrl') as string | null;

  if (callStatus !== 'completed') {
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  const supabase = createServiceClient();

  const { data: call } = await supabase.from('calls').select('*, customer:customers(*)').eq('call_sid', callSid).single();
  if (!call) {
    return new Response(JSON.stringify({ error: 'Call not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }

  const totalDuration = parseInt(callDuration || '0', 10);
  const now = new Date().toISOString();

  let billableMinutes = 0;
  if (call.connected_at) {
    billableMinutes = calculateBillableMinutes(call.connected_at, now);
  }

  const updateData: Record<string, unknown> = {
    ended_at: now,
    total_duration_seconds: totalDuration,
    billable_duration_seconds: call.connected_at
      ? Math.max(0, Math.floor((new Date(now).getTime() - new Date(call.connected_at).getTime()) / 1000))
      : 0,
    minutes_deducted: billableMinutes,
  };

  if (recordingUrl) updateData.recording_url = recordingUrl;

  await supabase.from('calls').update(updateData).eq('id', call.id);

  // Flip the connected rep into 'wrap_up' so the post-call questionnaire
  // modal opens and the queue stops routing to them. The rep-monitor cron
  // auto-clears wrap_up after wrap_up_grace_seconds if not submitted.
  if (call.rep_id) {
    const { data: prevRep } = await supabase
      .from('reps')
      .select('status')
      .eq('id', call.rep_id)
      .maybeSingle();

    if (prevRep && prevRep.status !== 'offline') {
      await supabase.from('reps').update({ status: 'wrap_up' }).eq('id', call.rep_id);
      await supabase.from('rep_status_events').insert({
        rep_id: call.rep_id,
        from_status: prevRep.status,
        to_status: 'wrap_up',
        reason: 'call_ended',
        call_id: call.id,
      });
    }
  }

  // Deduct minutes from customer balance
  if (call.customer_id && billableMinutes > 0) {
    await supabase.from('minute_ledger').insert({
      customer_id: call.customer_id,
      entry_type: 'deduction',
      minutes_amount: -billableMinutes,
      reason: `Call ${callSid} - ${billableMinutes} min`,
      call_id: call.id,
    });

    const { data: customer } = await supabase.from('customers').select('current_balance_minutes, total_minutes_used').eq('id', call.customer_id).single();
    if (customer) {
      await supabase.from('customers').update({
        current_balance_minutes: customer.current_balance_minutes - billableMinutes,
        total_minutes_used: customer.total_minutes_used + billableMinutes,
      }).eq('id', call.customer_id);
    }
  }

  // Trigger AI analysis if enabled
  const { data: aiSetting } = await supabase.from('admin_settings').select('value').eq('key', 'ai_analysis_enabled').single();
  if (aiSetting?.value === true || aiSetting?.value === 'true') {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    fetch(`${supabaseUrl}/functions/v1/ai-analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${serviceKey}` },
      body: JSON.stringify({ callId: call.id }),
    }).catch(() => {});
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
});

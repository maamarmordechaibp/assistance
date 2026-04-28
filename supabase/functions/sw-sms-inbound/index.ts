// Edge Function: sw-sms-inbound
// Receives SignalWire SMS webhook, stores SMS, detects OTP, auto-attaches to customer/call/rep
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { detectOtp } from '../email-inbound/detectOtp.ts';

function normalizeE164(num: string): string {
  let n = num.replace(/[^\d+]/g, '');
  if (!n.startsWith('+')) n = '+1' + n.replace(/^1/, '');
  return n;
}

serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const formData = await req.formData();
  const messageSid = formData.get('MessageSid') as string;
  const from = formData.get('From') as string;
  const to = formData.get('To') as string;
  const body = (formData.get('Body') as string) || '';
  const numSegments = Number(formData.get('NumSegments') || 1);
  const numMedia = Number(formData.get('NumMedia') || 0);
  const rawPayload: Record<string, unknown> = {};
  for (const [k, v] of formData.entries()) rawPayload[k] = v;

  const supabase = createServiceClient();
  // Idempotent insert by message_sid
  const { data: existing } = await supabase.from('sms_inbound').select('id').eq('message_sid', messageSid).maybeSingle();
  if (existing) return new Response(JSON.stringify({ ok: true, id: existing.id }), { headers: { 'Content-Type': 'application/json' } });

  // Normalize numbers
  const fromE164 = normalizeE164(from);
  const toE164 = normalizeE164(to);

  // Attach to customer by primary_phone
  const { data: customer } = await supabase.from('customers').select('id').eq('primary_phone', fromE164).maybeSingle();
  let customerId = customer?.id || null;
  let callId = null;
  let repId = null;
  if (customerId) {
    // Attach to active call (not ended)
    const { data: call } = await supabase.from('calls').select('id, rep_id').eq('customer_id', customerId).is('ended_at', null).order('started_at', { ascending: false }).limit(1).maybeSingle();
    if (call) {
      callId = call.id;
      repId = call.rep_id;
    }
  }
  // Detect OTP
  const detectedOtp = detectOtp(body);
  // Insert
  const { data: inserted, error } = await supabase.from('sms_inbound').insert({
    message_sid: messageSid,
    to_number: toE164,
    from_number: fromE164,
    body,
    num_segments: numSegments,
    num_media: numMedia,
    detected_otp: detectedOtp,
    customer_id: customerId,
    call_id: callId,
    rep_id: repId,
    received_at: new Date().toISOString(),
    raw_payload: rawPayload,
  }).select('id').maybeSingle();
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  return new Response(JSON.stringify({ ok: true, id: inserted?.id }), { headers: { 'Content-Type': 'application/json' } });
});

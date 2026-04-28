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

  // Attach to customer: check primary_phone, secondary_phone, then aliases
  const variants = [fromE164];
  const digits = fromE164.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    variants.push(`+${digits}`, digits.slice(1), `+1${digits.slice(1)}`);
  } else if (digits.length === 10) {
    variants.push(`+1${digits}`, `1${digits}`, `+${digits}`);
  }

  let customerId: string | null = null;
  // Primary phone
  { const { data: c } = await supabase.from('customers').select('id').in('primary_phone', variants).eq('status', 'active').limit(1).maybeSingle(); if (c) customerId = c.id; }
  // Secondary phone
  if (!customerId) { const { data: c } = await supabase.from('customers').select('id').in('secondary_phone', variants).eq('status', 'active').limit(1).maybeSingle(); if (c) customerId = c.id; }
  // Phone aliases
  if (!customerId) { const { data: a } = await supabase.from('customer_phone_aliases').select('customer_id').in('phone', variants).limit(1).maybeSingle(); if (a) customerId = a.customer_id; }

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

// Edge Function: sw-callback-choice (DTMF 1=callback, 2=hold)
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import * as laml from '../_shared/laml.ts';

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const formData = await req.formData();
  const digits = formData.get('Digits') as string;
  const from = formData.get('From') as string;
  const callSid = formData.get('CallSid') as string | null;

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const baseUrl = `${supabaseUrl}/functions/v1`;
  const elements: string[] = [];

  if (digits === '1') {
    const supabase = createServiceClient();

    // Avoid `.or()` here: PostgREST does not URL-encode values inside an
    // .or() expression, so the literal `+` in an E.164 number is decoded as
    // a space and never matches.
    let { data: customer } = await supabase
      .from('customers')
      .select('id, full_name')
      .eq('primary_phone', from)
      .limit(1)
      .maybeSingle();
    if (!customer) {
      const { data: secMatch } = await supabase
        .from('customers')
        .select('id, full_name')
        .eq('secondary_phone', from)
        .limit(1)
        .maybeSingle();
      customer = secMatch ?? null;
    }

    // Look up the caller's current call_queue row so we can preserve the
    // place they earned by waiting. If the same caller phones back later
    // (or we dial them and they re-enter the queue) we re-enqueue them at
    // this original timestamp instead of pushing them to the back.
    let originalEnqueuedAt: string | null = null;
    if (callSid) {
      const { data: q } = await supabase
        .from('call_queue')
        .select('enqueued_at')
        .eq('call_sid', callSid)
        .maybeSingle();
      originalEnqueuedAt = q?.enqueued_at ?? null;
    }

    // Upsert by call_sid so a duplicate webhook can't create two rows, and
    // so an explicit DTMF-1 request takes precedence over any auto-callback
    // that queue-exit might insert later for the same call.
    await supabase.from('callback_requests').upsert(
      {
        phone_number: from,
        customer_id: customer?.id || null,
        caller_name: customer?.full_name || null,
        call_sid: callSid,
        is_general: true,
        status: 'pending',
        original_enqueued_at: originalEnqueuedAt,
      },
      { onConflict: 'call_sid', ignoreDuplicates: false },
    );

    elements.push(laml.say('Thank you. We have saved your callback request. A representative will call you back as soon as possible. Goodbye.'));
    elements.push(laml.hangup());
  } else {
    // Caller pressed any non-1 digit (2 to keep holding, or anything else
    // like 9 from a misdial). Returning a <Redirect> here would EXIT the
    // <Enqueue> context entirely and disconnect the call — SignalWire only
    // re-issues waitUrl while the caller is still inside the queue. We send
    // an empty <Response> so SignalWire just resumes the regular wait loop
    // and the caller hears music until the next position announcement.
    // Returning XML with no children is intentional.
  }

  const xml = laml.buildLamlResponse(elements);
  return new Response(xml, { headers: { 'Content-Type': 'application/xml' } });
});

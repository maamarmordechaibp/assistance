// Edge Function: sw-post-call-feedback (IVR rating after call ends)
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import * as laml from '../_shared/laml.ts';

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const formData = await req.formData();
  const digits = formData.get('Digits') as string | null;
  const callSid = formData.get('CallSid') as string;

  const url = new URL(req.url);
  const step = url.searchParams.get('step') || 'ask';
  const callId = url.searchParams.get('callId');

  const supabase = createServiceClient();
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const baseUrl = `${supabaseUrl}/functions/v1`;

  const elements: string[] = [];

  if (step === 'ask') {
    // Find call by callId or callSid
    let resolvedCallId = callId;
    if (!resolvedCallId && callSid) {
      const { data: call } = await supabase.from('calls').select('id').eq('call_sid', callSid).single();
      resolvedCallId = call?.id;
    }

    elements.push(
      laml.gather(
        {
          input: 'dtmf',
          numDigits: 1,
          action: `${baseUrl}/sw-post-call-feedback?step=record&callId=${resolvedCallId || ''}`,
          timeout: 10,
        },
        [laml.say('Before you go, please rate your experience. Press 1 for poor, 2 for fair, 3 for good, 4 for very good, or 5 for excellent.')]
      )
    );
    // No input — just hang up
    elements.push(laml.say('Thank you for calling. Goodbye.'));
    elements.push(laml.hangup());
  } else if (step === 'record' && digits) {
    const rating = parseInt(digits, 10);

    if (rating >= 1 && rating <= 5 && callId) {
      // Look up the call to get customer and rep
      const { data: call } = await supabase
        .from('calls')
        .select('customer_id, rep_id')
        .eq('id', callId)
        .single();

      if (call?.customer_id && call?.rep_id) {
        await supabase.from('customer_feedback').insert({
          customer_id: call.customer_id,
          rep_id: call.rep_id,
          call_id: callId,
          rating,
        });
      }

      const labels = ['', 'poor', 'fair', 'good', 'very good', 'excellent'];
      elements.push(laml.say(`You rated this call as ${labels[rating]}. Thank you for your feedback. Goodbye.`));
    } else {
      elements.push(laml.say('Thank you for calling. Goodbye.'));
    }

    elements.push(laml.hangup());
  }

  return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
});

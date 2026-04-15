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

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const baseUrl = `${supabaseUrl}/functions/v1`;
  const elements: string[] = [];

  if (digits === '1') {
    const supabase = createServiceClient();

    const { data: customer } = await supabase
      .from('customers')
      .select('id')
      .or(`primary_phone.eq.${from},secondary_phone.eq.${from}`)
      .single();

    await supabase.from('callback_requests').insert({
      phone_number: from,
      customer_id: customer?.id || null,
    });

    elements.push(laml.say('Thank you. We have saved your callback request. A representative will call you back as soon as possible. Goodbye.'));
    elements.push(laml.hangup());
  } else {
    elements.push(laml.say('Thank you for continuing to hold. A representative will be with you shortly.'));
    elements.push(laml.redirect(`${baseUrl}/sw-queue-wait`));
  }

  const xml = laml.buildLamlResponse(elements);
  return new Response(xml, { headers: { 'Content-Type': 'application/xml' } });
});

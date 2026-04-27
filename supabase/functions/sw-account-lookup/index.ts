// Edge Function: sw-account-lookup (caller enters their account phone number)
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import * as laml from '../_shared/laml.ts';

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const formData = await req.formData();
  const digits = formData.get('Digits') as string | null;

  const url = new URL(req.url);
  const customerId = url.searchParams.get('customerId');
  const step = url.searchParams.get('step') || 'prompt';

  const supabase = createServiceClient();
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const baseUrl = `${supabaseUrl}/functions/v1`;

  const elements: string[] = [];

  if (step === 'prompt' || !digits) {
    // Ask caller to enter their phone number
    elements.push(
      laml.gather(
        {
          input: 'dtmf',
          action: `${baseUrl}/sw-account-lookup?step=lookup&customerId=${customerId}`,
          timeout: 15,
          finishOnKey: '#',
        },
        [laml.say('Please enter the phone number associated with your account using the keypad, followed by the pound sign.')]
      )
    );
    // Timeout fallback
    elements.push(laml.say('No input received. Connecting you to a representative.'));
    elements.push(laml.enqueue('main-queue', `${baseUrl}/sw-queue-wait`));
  } else if (step === 'lookup' && digits) {
    // Format: add +1 if 10 digits (US), or +{digits} if 11+
    let phone = digits.replace(/\D/g, '');
    if (phone.length === 10) phone = `+1${phone}`;
    else if (phone.length === 11 && phone.startsWith('1')) phone = `+${phone}`;
    else phone = `+${phone}`;

    // Look up customer by entered phone number.
    // Avoid `.or()` here: PostgREST does not URL-encode values inside an .or()
    // expression, so the literal `+` in an E.164 number is decoded as a space
    // and never matches. `.eq()` properly encodes its argument.
    let { data: customer } = await supabase
      .from('customers')
      .select('id, full_name, current_balance_minutes')
      .eq('primary_phone', phone)
      .eq('status', 'active')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!customer) {
      const { data: secMatch } = await supabase
        .from('customers')
        .select('id, full_name, current_balance_minutes')
        .eq('secondary_phone', phone)
        .eq('status', 'active')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      customer = secMatch ?? null;
    }

    if (customer) {
      // Update the call record to link to the found customer
      const callSid = formData.get('CallSid') as string;
      if (callSid) {
        await supabase.from('calls').update({ customer_id: customer.id }).eq('call_sid', callSid);
      }

      const isNewCaller = customer.full_name.startsWith('Caller ');
      if (isNewCaller) {
        elements.push(laml.say('Account found. Connecting you to a representative who will verify your identity.'));
      } else {
        elements.push(laml.say(`Account found for ${customer.full_name}. Connecting you to a representative who will verify your identity.`));
      }
      elements.push(laml.enqueue('main-queue', `${baseUrl}/sw-queue-wait`));
    } else {
      // Not found — offer retry or connect anyway
      elements.push(
        laml.gather(
          {
            input: 'dtmf',
            numDigits: 1,
            action: `${baseUrl}/sw-account-lookup?step=retry&customerId=${customerId}`,
            timeout: 8,
          },
          [laml.say('We could not find an account with that phone number. Press 1 to try again, or press 2 to speak with a representative.')]
        )
      );
      elements.push(laml.say('Connecting you to a representative.'));
      elements.push(laml.enqueue('main-queue', `${baseUrl}/sw-queue-wait`));
    }
  } else if (step === 'retry' && digits) {
    if (digits === '1') {
      elements.push(laml.redirect(`${baseUrl}/sw-account-lookup?step=prompt&customerId=${customerId}`));
    } else {
      elements.push(laml.say('Connecting you to a representative.'));
      elements.push(laml.enqueue('main-queue', `${baseUrl}/sw-queue-wait`));
    }
  }

  return new Response(laml.buildLamlResponse(elements), { headers: { 'Content-Type': 'application/xml' } });
});

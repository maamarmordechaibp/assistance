// Edge Function: sw-payment-gather (multi-step DTMF card gathering & processing)
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import * as laml from '../_shared/laml.ts';
import { processCreditCardSale } from '../_shared/sola.ts';

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const formData = await req.formData();
  const digits = formData.get('Digits') as string;

  const url = new URL(req.url);
  const step = url.searchParams.get('step') || 'card';
  const customerId = url.searchParams.get('customerId') || '';
  const packageId = url.searchParams.get('packageId') || '';

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const baseUrl = `${supabaseUrl}/functions/v1`;
  const elements: string[] = [];
  const supabase = createServiceClient();

  switch (step) {
    case 'card': {
      elements.push(
        laml.gather(
          { input: 'dtmf', numDigits: 16, action: `${baseUrl}/sw-payment-gather?step=exp&customerId=${customerId}&packageId=${packageId}`, timeout: 30, finishOnKey: '#' },
          [laml.say('Please enter your credit card number using your phone keypad, followed by the pound key.')]
        )
      );
      // Fallback if the Gather times out — re-prompt instead of hanging up.
      elements.push(laml.say('We did not receive your card number.'));
      elements.push(laml.redirect(`${baseUrl}/sw-payment-gather?step=card&customerId=${customerId}&packageId=${packageId}`));
      break;
    }
    case 'exp': {
      const cardNum = digits;
      elements.push(
        laml.gather(
          { input: 'dtmf', numDigits: 4, action: `${baseUrl}/sw-payment-gather?step=cvv&customerId=${customerId}&packageId=${packageId}&cn=${cardNum}`, timeout: 20, finishOnKey: '#' },
          [laml.say('Thank you. Please enter your card expiration date as four digits. For example, for January 2026, enter 0 1 2 6.')]
        )
      );
      elements.push(laml.say('We did not receive your expiration date.'));
      elements.push(laml.redirect(`${baseUrl}/sw-payment-gather?step=card&customerId=${customerId}&packageId=${packageId}`));
      break;
    }
    case 'cvv': {
      const cardNum = url.searchParams.get('cn') || '';
      const exp = digits;
      elements.push(
        laml.gather(
          { input: 'dtmf', numDigits: 4, action: `${baseUrl}/sw-payment-gather?step=process&customerId=${customerId}&packageId=${packageId}&cn=${cardNum}&exp=${exp}`, timeout: 20, finishOnKey: '#' },
          [laml.say('Please enter your 3 or 4 digit security code on the back of your card, followed by the pound key.')]
        )
      );
      elements.push(laml.say('We did not receive your security code.'));
      elements.push(laml.redirect(`${baseUrl}/sw-payment-gather?step=card&customerId=${customerId}&packageId=${packageId}`));
      break;
    }
    case 'process': {
      const cardNum = url.searchParams.get('cn') || '';
      const exp = url.searchParams.get('exp') || '';
      const cvv = digits;

      const { data: pkg } = await supabase.from('payment_packages').select('*').eq('id', packageId).single();
      if (!pkg) {
        elements.push(laml.say('Sorry, the selected package was not found. Please try again.'));
        elements.push(laml.hangup());
        break;
      }

      try {
        const paymentResult = await processCreditCardSale({
          amount: pkg.price,
          cardNumber: cardNum,
          expiration: exp,
          cvv,
          invoice: `pkg-${pkg.id}-${Date.now()}`,
        });

        if (paymentResult.xResult === 'A') {
          const { data: payment } = await supabase.from('payments').insert({
            customer_id: customerId,
            package_id: pkg.id,
            package_name: pkg.name,
            minutes_added: pkg.minutes,
            amount_paid: pkg.price,
            payment_status: 'completed',
            sola_transaction_ref: paymentResult.xRefNum,
            sola_token: paymentResult.xToken,
          }).select().single();

          const { data: customer } = await supabase.from('customers').select('current_balance_minutes, total_minutes_purchased').eq('id', customerId).single();
          if (customer) {
            await supabase.from('customers').update({
              current_balance_minutes: customer.current_balance_minutes + pkg.minutes,
              total_minutes_purchased: customer.total_minutes_purchased + pkg.minutes,
            }).eq('id', customerId);
          }

          await supabase.from('minute_ledger').insert({
            customer_id: customerId,
            entry_type: 'purchase',
            minutes_amount: pkg.minutes,
            dollar_amount: pkg.price,
            reason: `Payment for ${pkg.name} package`,
            payment_id: payment?.id,
          });

          elements.push(laml.say(`Your payment of $${pkg.price} has been approved. ${pkg.minutes} minutes have been added to your account. Thank you.`));
          elements.push(laml.pause(1));
          elements.push(laml.say('You will now be connected to a representative.'));
          elements.push(laml.enqueue('main-queue', `${baseUrl}/sw-queue-wait`));
        } else {
          await supabase.from('payments').insert({
            customer_id: customerId,
            package_id: pkg.id,
            package_name: pkg.name,
            minutes_added: 0,
            amount_paid: pkg.price,
            payment_status: 'failed',
            sola_transaction_ref: paymentResult.xRefNum || '',
          });

          elements.push(laml.say('Sorry, your payment was not approved. Please check your card details and try again later.'));
        }
      } catch (err) {
        console.error('Payment processing error:', err);
        elements.push(laml.say('We encountered an error processing your payment. Please try again later.'));
      }
      break;
    }
  }

  const xml = laml.buildLamlResponse(elements);
  return new Response(xml, { headers: { 'Content-Type': 'application/xml' } });
});

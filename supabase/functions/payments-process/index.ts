// Edge Function: payments-process (POST card or token payment)
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createUserClient, createServiceClient, getUser } from '../_shared/supabase.ts';
import { processCreditCardSale, processTokenSale } from '../_shared/sola.ts';

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const user = await getUser(req);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const body = await req.json();
  const { customerId, packageId, token, cardNumber, expiration, cvv } = body;

  if (!customerId || !packageId) {
    return new Response(JSON.stringify({ error: 'customerId and packageId required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const supabase = createServiceClient();

  // Get package
  const { data: pkg } = await supabase.from('payment_packages').select('*').eq('id', packageId).eq('is_active', true).single();
  if (!pkg) {
    return new Response(JSON.stringify({ error: 'Package not found or inactive' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  try {
    let paymentResult;
    const invoice = `pkg-${pkg.id}-${Date.now()}`;

    if (token) {
      paymentResult = await processTokenSale({ amount: pkg.price, token, invoice });
    } else if (cardNumber && expiration && cvv) {
      paymentResult = await processCreditCardSale({ amount: pkg.price, cardNumber, expiration, cvv, invoice });
    } else {
      return new Response(JSON.stringify({ error: 'Provide either token or card details (cardNumber, expiration, cvv)' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (paymentResult.xResult === 'A') {
      const { data: payment } = await supabase
        .from('payments')
        .insert({
          customer_id: customerId,
          package_id: pkg.id,
          package_name: pkg.name,
          minutes_added: pkg.minutes,
          amount_paid: pkg.price,
          payment_status: 'completed',
          sola_transaction_ref: paymentResult.xRefNum,
          sola_token: paymentResult.xToken,
        })
        .select()
        .single();

      // Update balance
      const { data: customer } = await supabase.from('customers').select('current_balance_minutes, total_minutes_purchased').eq('id', customerId).single();
      if (customer) {
        await supabase.from('customers').update({
          current_balance_minutes: customer.current_balance_minutes + pkg.minutes,
          total_minutes_purchased: customer.total_minutes_purchased + pkg.minutes,
        }).eq('id', customerId);
      }

      // Ledger entry
      await supabase.from('minute_ledger').insert({
        customer_id: customerId,
        entry_type: 'purchase',
        minutes_amount: pkg.minutes,
        dollar_amount: pkg.price,
        reason: `Payment for ${pkg.name} package`,
        performed_by: user.id,
        payment_id: payment?.id,
      });

      return new Response(JSON.stringify({ success: true, payment, message: `${pkg.minutes} minutes added` }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
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

      return new Response(JSON.stringify({ success: false, error: paymentResult.xError || 'Payment declined' }), { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
  } catch (err) {
    console.error('Payment error:', err);
    return new Response(JSON.stringify({ error: 'Payment processing failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});

// Edge Function: payment-methods
//   GET    ?customerId=  → list saved cards (masked, never the raw token)
//   POST   { customerId, paymentMethodId, packageId } → charge saved card
//   DELETE ?id=          → deactivate a saved card
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createServiceClient, getUser } from '../_shared/supabase.ts';
import { processTokenSale } from '../_shared/sola.ts';

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const user = await getUser(req);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createServiceClient();
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const customerId = url.searchParams.get('customerId');
    if (!customerId) {
      return new Response(JSON.stringify({ error: 'customerId required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const { data } = await supabase
      .from('customer_payment_methods')
      .select('id, card_brand, card_last4, card_exp, cardholder_name, is_default, created_at, last_used_at')
      .eq('customer_id', customerId)
      .eq('is_active', true)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false });
    return new Response(JSON.stringify({ methods: data ?? [] }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (req.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) {
      return new Response(JSON.stringify({ error: 'id required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    await supabase.from('customer_payment_methods').update({ is_active: false }).eq('id', id);
    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (req.method === 'POST') {
    const body = await req.json();
    const { customerId, packageId, paymentMethodId } = body;
    if (!customerId || !packageId || !paymentMethodId) {
      return new Response(JSON.stringify({ error: 'customerId, packageId, and paymentMethodId required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: pm } = await supabase
      .from('customer_payment_methods')
      .select('*')
      .eq('id', paymentMethodId)
      .eq('customer_id', customerId)
      .eq('is_active', true)
      .maybeSingle();
    if (!pm) {
      return new Response(JSON.stringify({ error: 'Payment method not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: pkg } = await supabase
      .from('payment_packages')
      .select('*')
      .eq('id', packageId)
      .eq('is_active', true)
      .single();
    if (!pkg) {
      return new Response(JSON.stringify({ error: 'Package not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const invoice = `pkg-${pkg.id}-${Date.now()}`;
    const result = await processTokenSale({
      amount: pkg.price,
      token: pm.sola_token,
      invoice,
      customerName: pm.cardholder_name || undefined,
    });

    if (result.xResult !== 'A') {
      await supabase.from('payments').insert({
        customer_id: customerId, package_id: pkg.id, package_name: pkg.name,
        minutes_added: 0, amount_paid: pkg.price, payment_status: 'failed',
        sola_transaction_ref: result.xRefNum || '',
      });
      return new Response(JSON.stringify({ success: false, error: result.xError || 'Card declined' }), {
        status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: payment } = await supabase.from('payments').insert({
      customer_id: customerId, package_id: pkg.id, package_name: pkg.name,
      minutes_added: pkg.minutes, amount_paid: pkg.price, payment_status: 'completed',
      sola_transaction_ref: result.xRefNum, sola_token: pm.sola_token,
    }).select().single();

    const { data: customer } = await supabase
      .from('customers')
      .select('current_balance_minutes, total_minutes_purchased')
      .eq('id', customerId).single();
    if (customer) {
      await supabase.from('customers').update({
        current_balance_minutes: customer.current_balance_minutes + pkg.minutes,
        total_minutes_purchased: customer.total_minutes_purchased + pkg.minutes,
      }).eq('id', customerId);
    }

    await supabase.from('minute_ledger').insert({
      customer_id: customerId, entry_type: 'purchase',
      minutes_amount: pkg.minutes, dollar_amount: pkg.price,
      reason: `Payment for ${pkg.name} (saved card ····${pm.card_last4})`,
      performed_by: user.id, payment_id: payment?.id,
    });

    await supabase.from('customer_payment_methods')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', pm.id);

    return new Response(JSON.stringify({
      success: true, payment, minutesAdded: pkg.minutes,
      message: `${pkg.minutes} minutes added (saved card ····${pm.card_last4})`,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});

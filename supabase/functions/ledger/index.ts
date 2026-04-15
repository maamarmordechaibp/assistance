// Edge Function: ledger (GET history, POST admin adjustment)
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createUserClient, getUser } from '../_shared/supabase.ts';

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const user = await getUser(req);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const supabase = createUserClient(req);
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const customerId = url.searchParams.get('customerId');
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const offset = (page - 1) * limit;

    if (!customerId) {
      return new Response(JSON.stringify({ error: 'customerId required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { data, count, error } = await supabase
      .from('minute_ledger')
      .select('*', { count: 'exact' })
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ entries: data, total: count, page, limit }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  if (req.method === 'POST') {
    const role = user.app_metadata?.role;
    if (role !== 'admin') {
      return new Response(JSON.stringify({ error: 'Admin access required' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const body = await req.json();
    const { customerId, entryType, minutesAmount, reason } = body;

    if (!customerId || !entryType || minutesAmount === undefined) {
      return new Response(JSON.stringify({ error: 'customerId, entryType, and minutesAmount required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { data: entry, error } = await supabase
      .from('minute_ledger')
      .insert({
        customer_id: customerId,
        entry_type: entryType,
        minutes_amount: minutesAmount,
        reason: reason || `Manual ${entryType} by admin`,
        performed_by: user.id,
      })
      .select()
      .single();

    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    // Update customer balance
    const { data: customer } = await supabase.from('customers').select('current_balance_minutes').eq('id', customerId).single();
    if (customer) {
      await supabase.from('customers').update({ current_balance_minutes: customer.current_balance_minutes + minutesAmount }).eq('id', customerId);
    }

    return new Response(JSON.stringify(entry), { status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});

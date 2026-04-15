// Edge Function: withdrawals (owner payout/withdrawal management)
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { createUserClient, createServiceClient, getUser } from '../_shared/supabase.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const user = await getUser(req);
  if (!user || user.app_metadata?.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Admin only' }), {
      status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const service = createServiceClient();
  const url = new URL(req.url);

  if (req.method === 'GET') {
    // Get withdrawals + financial summary
    const { data: withdrawals } = await service
      .from('owner_withdrawals')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    // Calculate total revenue from completed payments
    const { data: payments } = await service
      .from('payments')
      .select('amount_paid')
      .eq('payment_status', 'completed');

    const totalRevenue = payments?.reduce((sum: number, p: { amount_paid: number }) => sum + p.amount_paid, 0) || 0;
    const totalWithdrawn = withdrawals?.reduce((sum: number, w: { amount: number; status: string }) =>
      w.status === 'completed' ? sum + Number(w.amount) : sum, 0) || 0;

    // Estimate costs: total minutes used * $0.24/min (worker + phone + overhead)
    const { data: customers } = await service
      .from('customers')
      .select('total_minutes_used');
    const totalMinutesUsed = customers?.reduce((sum: number, c: { total_minutes_used: number }) => sum + c.total_minutes_used, 0) || 0;
    const estimatedCosts = totalMinutesUsed * 0.24; // configurable later

    return new Response(JSON.stringify({
      withdrawals,
      summary: {
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalWithdrawn: Math.round(totalWithdrawn * 100) / 100,
        estimatedCosts: Math.round(estimatedCosts * 100) / 100,
        availableBalance: Math.round((totalRevenue - totalWithdrawn - estimatedCosts) * 100) / 100,
        totalMinutesUsed,
      },
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (req.method === 'POST') {
    const body = await req.json();
    const { amount, method, notes } = body;
    if (!amount || amount <= 0) {
      return new Response(JSON.stringify({ error: 'Valid amount required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data, error } = await service.from('owner_withdrawals').insert({
      amount, method: method || 'bank_transfer', notes: notes || null,
    }).select().single();

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(data), {
      status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response('Method not allowed', { status: 405, headers: corsHeaders });
});

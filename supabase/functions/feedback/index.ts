// Edge Function: feedback (admin CRUD for customer feedback)
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { createServiceClient, getUser } from '../_shared/supabase.ts';

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const user = await getUser(req);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const supabase = createServiceClient();
  const url = new URL(req.url);

  if (req.method === 'GET') {
    // Query params: repId, customerId, limit
    const repId = url.searchParams.get('repId');
    const customerId = url.searchParams.get('customerId');
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);

    let query = supabase
      .from('customer_feedback')
      .select('*, customers:customer_id(full_name), reps:rep_id(full_name), calls:call_id(started_at)')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (repId) query = query.eq('rep_id', repId);
    if (customerId) query = query.eq('customer_id', customerId);

    const { data, error } = await query;
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    // Calculate average rating per rep if no filters
    let summary: { repId: string; repName: string; avgRating: number; totalReviews: number }[] | null = null;
    if (!repId && !customerId) {
      if (data && data.length > 0) {
        const byRep: Record<string, { total: number; count: number; name: string }> = {};
        for (const fb of data) {
          const rid = fb.rep_id;
          if (!rid) continue;
          if (!byRep[rid]) byRep[rid] = { total: 0, count: 0, name: (fb.reps as { full_name: string } | null)?.full_name || 'Unknown' };
          byRep[rid].total += fb.rating;
          byRep[rid].count += 1;
        }
        summary = Object.entries(byRep).map(([repId, d]) => ({
          repId,
          repName: d.name,
          avgRating: Math.round((d.total / d.count) * 10) / 10,
          totalReviews: d.count,
        }));
      }
    }

    return new Response(JSON.stringify({ feedback: data ?? [], summary: summary ?? [] }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  if (req.method === 'POST') {
    // Manual feedback entry by admin/rep
    const body = await req.json();
    const { customer_id, rep_id, call_id, rating, comment } = body;

    if (!customer_id || !rep_id || !rating) {
      return new Response(JSON.stringify({ error: 'customer_id, rep_id, and rating are required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { data, error } = await supabase.from('customer_feedback').insert({
      customer_id, rep_id, call_id, rating, comment,
    }).select().single();

    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(data), { status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  if (req.method === 'DELETE') {
    const role = user.app_metadata?.role;
    if (role !== 'admin') {
      return new Response(JSON.stringify({ error: 'Admin only' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const id = url.searchParams.get('id');
    if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const { error } = await supabase.from('customer_feedback').delete().eq('id', id);
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});

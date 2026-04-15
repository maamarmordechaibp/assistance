// Edge Function: callbacks (GET pending, PATCH complete)
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
    const status = url.searchParams.get('status') || 'pending';

    const { data, error } = await supabase
      .from('callback_requests')
      .select('*, customer:customers(id, full_name, primary_phone)')
      .eq('status', status)
      .order('requested_at', { ascending: true });

    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(data), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  if (req.method === 'PATCH') {
    const body = await req.json();
    const { id, status: newStatus, notes } = body;

    if (!id) return new Response(JSON.stringify({ error: 'id is required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const updateData: Record<string, unknown> = {
      status: newStatus || 'called_back',
      called_back_at: new Date().toISOString(),
      called_back_by: user.id,
    };
    if (notes) updateData.notes = notes;

    const { data, error } = await supabase.from('callback_requests').update(updateData).eq('id', id).select().single();
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(data), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});

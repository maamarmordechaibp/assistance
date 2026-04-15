// Edge Function: calls (GET list, PATCH update)
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
    const repId = url.searchParams.get('repId');
    const flagStatus = url.searchParams.get('flagStatus');
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const limit = parseInt(url.searchParams.get('limit') || '25', 10);
    const offset = (page - 1) * limit;

    let query = supabase
      .from('calls')
      .select(`*, customer:customers(id, full_name, primary_phone), rep:reps(id, full_name), task_category:task_categories(id, name), analysis:call_analyses(*)`, { count: 'exact' })
      .order('started_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (customerId) query = query.eq('customer_id', customerId);
    if (repId) query = query.eq('rep_id', repId);
    if (flagStatus) query = query.eq('flag_status', flagStatus);

    const { data, count, error } = await query;
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ calls: data, total: count, page, limit }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  if (req.method === 'PATCH') {
    const body = await req.json();
    const { id, ...updates } = body;
    if (!id) return new Response(JSON.stringify({ error: 'id is required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const dbUpdates: Record<string, unknown> = {};
    if (updates.repNotes !== undefined) dbUpdates.rep_notes = updates.repNotes;
    if (updates.taskCategoryId !== undefined) dbUpdates.task_category_id = updates.taskCategoryId;
    if (updates.outcomeStatus !== undefined) dbUpdates.outcome_status = updates.outcomeStatus;
    if (updates.followupNeeded !== undefined) dbUpdates.followup_needed = updates.followupNeeded;
    if (updates.flagStatus !== undefined) dbUpdates.flag_status = updates.flagStatus;
    if (updates.flagReason !== undefined) dbUpdates.flag_reason = updates.flagReason;

    const { data, error } = await supabase.from('calls').update(dbUpdates).eq('id', id).select().single();
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(data), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});

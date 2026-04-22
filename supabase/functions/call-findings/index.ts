// Edge Function: call-findings
// GET  ?customerId=...   — list findings for a customer (most recent first)
// POST                   — manually log a finding during an active call
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createUserClient, createServiceClient, getUser } from '../_shared/supabase.ts';

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const supabase = createUserClient(req);
  const user = await getUser(supabase);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(req.url);

  // ── GET: list findings ────────────────────────────────────
  if (req.method === 'GET') {
    const customerId = url.searchParams.get('customerId');
    const search = url.searchParams.get('search');

    const svc = createServiceClient();
    let query = svc
      .from('call_findings')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (customerId) query = query.eq('customer_id', customerId);
    if (search) {
      // Use websearch FTS for natural language search
      query = query.textSearch('description', search, { type: 'websearch', config: 'english' });
    }

    const { data, error } = await query;
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // ── POST: log a new finding ───────────────────────────────
  if (req.method === 'POST') {
    const body = await req.json();
    const { callId, customerId, description, itemUrl, itemPrice, itemPlatform, itemNotes, searchTerms } = body;

    if (!description?.trim()) {
      return new Response(JSON.stringify({ error: 'description is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const svc = createServiceClient();

    // Resolve rep_id from the authenticated user
    const { data: rep } = await svc.from('reps').select('id').eq('id', user.id).maybeSingle();

    const { data, error } = await svc.from('call_findings').insert({
      call_id: callId || null,
      customer_id: customerId || null,
      rep_id: rep?.id || null,
      description: description.trim(),
      item_url: itemUrl?.trim() || null,
      item_price: itemPrice?.trim() || null,
      item_platform: itemPlatform?.trim() || null,
      item_notes: itemNotes?.trim() || null,
      search_terms: Array.isArray(searchTerms) ? searchTerms : [],
      source: 'manual',
    }).select().single();

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(data), {
      status: 201,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // ── DELETE: remove a finding ──────────────────────────────
  if (req.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) {
      return new Response(JSON.stringify({ error: 'id required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const svc = createServiceClient();
    const { error } = await svc.from('call_findings').delete().eq('id', id);
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});

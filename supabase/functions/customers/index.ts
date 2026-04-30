// Edge Function: customers (GET search, POST create, PATCH update)
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createServiceClient, getUser } from '../_shared/supabase.ts';

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const user = await getUser(req);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const supabase = createServiceClient();
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const search = url.searchParams.get('search') || '';
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const limit = parseInt(url.searchParams.get('limit') || '25', 10);
    const offset = (page - 1) * limit;

    let query = supabase
      .from('customers')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (search) {
      query = query.or(`full_name.ilike.%${search}%,primary_phone.ilike.%${search}%,email.ilike.%${search}%`);
    }

    const { data, count, error } = await query;
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ customers: data, total: count, page, limit }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  if (req.method === 'POST') {
    const body = await req.json();
    const { fullName, primaryPhone, secondaryPhone, email, address, internalNotes } = body;

    if (!fullName || !primaryPhone) {
      return new Response(JSON.stringify({ error: 'fullName and primaryPhone are required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { data, error } = await supabase
      .from('customers')
      .insert({
        full_name: fullName,
        primary_phone: primaryPhone,
        secondary_phone: secondaryPhone || null,
        email: email || null,
        address: address || null,
        internal_notes: internalNotes || null,
      })
      .select()
      .single();

    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(data), { status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  if (req.method === 'PATCH') {
    const body = await req.json();
    const { id, ...updates } = body;
    if (!id) return new Response(JSON.stringify({ error: 'id is required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const dbUpdates: Record<string, unknown> = {};
    if (updates.fullName !== undefined) dbUpdates.full_name = updates.fullName;
    if (updates.primaryPhone !== undefined) dbUpdates.primary_phone = updates.primaryPhone;
    if (updates.secondaryPhone !== undefined) dbUpdates.secondary_phone = updates.secondaryPhone;
    if (updates.email !== undefined) dbUpdates.email = updates.email;
    if (updates.address !== undefined) dbUpdates.address = updates.address;
    if (updates.internalNotes !== undefined) dbUpdates.internal_notes = updates.internalNotes;
    if (updates.status !== undefined) dbUpdates.status = updates.status;
    if (updates.preferredRepId !== undefined) dbUpdates.preferred_rep_id = updates.preferredRepId || null;
    if (updates.personalEmail !== undefined) dbUpdates.personal_email = updates.personalEmail || null;
    if (updates.autoForwardMode !== undefined) {
      const m = String(updates.autoForwardMode);
      if (!['off', 'all', 'allowlist'].includes(m)) {
        return new Response(JSON.stringify({ error: 'autoForwardMode must be off|all|allowlist' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      dbUpdates.auto_forward_mode = m;
    }
    if (updates.autoForwardSenders !== undefined) {
      if (!Array.isArray(updates.autoForwardSenders)) {
        return new Response(JSON.stringify({ error: 'autoForwardSenders must be an array of strings' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      dbUpdates.auto_forward_senders = updates.autoForwardSenders
        .map((s: unknown) => String(s).trim().toLowerCase())
        .filter((s: string) => s.length > 0);
    }

    const { data, error } = await supabase.from('customers').update(dbUpdates).eq('id', id).select().single();
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(data), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});

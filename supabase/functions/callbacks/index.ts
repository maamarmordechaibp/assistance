// Edge Function: callbacks (list pending, mark complete, initiate outbound callback)
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders, handleCors } from '../_shared/cors.ts';
import { createServiceClient, getUser } from '../_shared/supabase.ts';
import { createCall } from '../_shared/signalwire.ts';

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const user = await getUser(req);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const supabase = createServiceClient();
  const url = new URL(req.url);

  // GET — list callbacks; reps see their own + general, admins see all
  if (req.method === 'GET') {
    const status = url.searchParams.get('status') || 'pending';
    const filterRepId = url.searchParams.get('rep_id');

    // Get the logged-in user's rep record (if any)
    const { data: rep } = await supabase
      .from('reps')
      .select('id')
      .eq('email', user.email)
      .maybeSingle();

    let query = supabase
      .from('callback_requests')
      .select('*, customer:customers(id, full_name, primary_phone)')
      .eq('status', status)
      .order('requested_at', { ascending: true });

    if (filterRepId) {
      // Explicit filter (admin use)
      query = query.eq('rep_id', filterRepId);
    } else if (rep) {
      // Reps see their own specific callbacks + general ones (rep_id IS NULL)
      query = query.or(`rep_id.eq.${rep.id},rep_id.is.null`);
    }
    // Admins (no rep record) see everything

    const { data, error } = await query;
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(data), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  // PATCH — mark a callback complete / update status
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

  // POST — initiate an outbound callback call via SignalWire REST API
  if (req.method === 'POST') {
    const body = await req.json();
    const { id } = body;  // callback_requests.id
    if (!id) return new Response(JSON.stringify({ error: 'id is required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const { data: cb, error: cbErr } = await supabase
      .from('callback_requests')
      .select('*, customer:customers(full_name)')
      .eq('id', id)
      .single();
    if (cbErr || !cb) return new Response(JSON.stringify({ error: 'Callback not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    // The outbound call's LAML URL routes back through sw-inbound so the
    // existing rep-ring logic handles connecting the answered customer to the rep.
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const baseUrl = `${supabaseUrl}/functions/v1`;

    // Get the rep making the call (so we can route back to them)
    const { data: rep } = await supabase.from('reps').select('id').eq('email', user.email).maybeSingle();

    const callbackUrl = rep
      ? `${baseUrl}/sw-inbound?step=callback-answer&repId=${rep.id}&callbackId=${id}`
      : `${baseUrl}/sw-inbound?step=connect-rep`;

    // Originate the outbound call to the customer
    const swFrom = Deno.env.get('SIGNALWIRE_FROM_NUMBER') || Deno.env.get('SIGNALWIRE_PHONE_NUMBER') || '';
    try {
      const callData = await createCall({
        to: cb.phone_number,
        from: swFrom,
        url: callbackUrl,
        record: true,
        recordingStatusCallback: `${baseUrl}/sw-recording-complete`,
      });

      // Mark as in-progress
      await supabase.from('callback_requests').update({ status: 'calling' }).eq('id', id);

      return new Response(JSON.stringify({ success: true, callSid: callData.sid }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ error: msg }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});

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

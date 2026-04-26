// Edge Function: voicemails (admin list / signed url / mark played / delete)
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
  const role = user.app_metadata?.role;
  if (role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Admin only' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const supabase = createServiceClient();
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const action = url.searchParams.get('action') || 'list';

    if (action === 'list') {
      const mailbox = url.searchParams.get('mailbox');
      const includeArchived = url.searchParams.get('includeArchived') === '1';
      let q = supabase
        .from('voicemails')
        .select('id, customer_id, caller_phone, mailbox, recording_storage_path, transcript_text, duration_seconds, played_at, played_by_rep_id, archived_at, created_at, customers:customer_id(full_name)')
        .order('created_at', { ascending: false })
        .limit(200);
      if (mailbox) q = q.eq('mailbox', mailbox);
      if (!includeArchived) q = q.is('archived_at', null);
      const { data, error } = await q;
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ voicemails: data ?? [] }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'signed-url') {
      const id = url.searchParams.get('id');
      if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const { data: vm } = await supabase.from('voicemails').select('recording_storage_path').eq('id', id).single();
      if (!vm?.recording_storage_path) {
        return new Response(JSON.stringify({ error: 'Recording not available' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const { data: signed, error: signedErr } = await supabase.storage
        .from('call-recordings')
        .createSignedUrl(vm.recording_storage_path, 60 * 10);
      if (signedErr || !signed) return new Response(JSON.stringify({ error: signedErr?.message || 'Failed to sign url' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ url: signed.signedUrl }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  if (req.method === 'PATCH') {
    const body = await req.json();
    const { id, played, archived } = body;
    if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const update: Record<string, string | null> = {};
    if (played === true) {
      update.played_at = new Date().toISOString();
      update.played_by_rep_id = user.id;
    } else if (played === false) {
      update.played_at = null;
      update.played_by_rep_id = null;
    }
    if (archived === true) update.archived_at = new Date().toISOString();
    else if (archived === false) update.archived_at = null;
    const { error } = await supabase.from('voicemails').update(update).eq('id', id);
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  if (req.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const { data: vm } = await supabase.from('voicemails').select('recording_storage_path').eq('id', id).single();
    if (vm?.recording_storage_path) {
      await supabase.storage.from('call-recordings').remove([vm.recording_storage_path]).catch(() => {});
    }
    const { error } = await supabase.from('voicemails').delete().eq('id', id);
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
